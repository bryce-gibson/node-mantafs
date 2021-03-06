// Copyright 2014 Joyent, Inc.  All rights reserved.
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

var events = require('events');
var fs = require('fs');
var path = require('path');
var util = require('util');
var vasync = require('vasync');

var assert = require('assert-plus');
var levelup = require('levelup');
var LRU = require('lru-cache');
var LineStream = require('lstream');
var manta = require('manta');
var once = require('once');
var uuid = require('node-uuid');

var DirStream = require('./readdir_stream');
var ErrnoError = require('./errors').ErrnoError;
var xlateMantaError = require('./errors').xlateMantaError;
var utils = require('./utils');


///--- Globals

var sprintf = util.format;

var CACHE_DIR_NAME = 'fscache';
var DB_NAME = 'mantafs.db';

// DB key for tracking dirty files (pathname to timestamp)
var DIRTY_KEY_FMT = ':d:%s';
// DB key for pathname to uuid mapping
var FHANDLE_KEY_FMT = ':fh:%s';
// DB key for pathname to 'stats' data (see mantaToStats)
var FILES_KEY_FMT = ':f:%s';
// DB key for uuid to pathname mapping
var FNAME_KEY_FMT = ':fn:%s';

// CACHING

// There are two configuration options which control how objects are cached.
//
// The first is the ttl (time-to-live). This controls how long object metadata
// is used before we go back to Manta to check if the local data is stale.
// It does not control how long before a file is evicted from the cache, since
// the object can be kept as long as it is not stale. The last_stat value on
// the local metadata is used to track how old the local copy is. Whenever we
// 'get' the metadata internally, we check to see if it has expired, and if so,
// re-stat back to Manta. This also results in an update to the local last_stat
// value on the metadata.
//
// The second option is the maximum size of the cache. When downloading an
// object into the cache, if this would put us over the size limit, then we
// asynchronously start to evict objects from the cache to free up space. We use
// the LRU cache to determine the order for which files to evict from the cache.
// We never use the LRU cache dispose function since the cached objects are
// asynchronously removed when we're over the size limit.

// For stale file handling, once the local metadata has expired we need to
// check Manta to see if the object has changed behind our back. Once we get
// the header info, we can compare with the local info to determine if we
// should discard the cached object. Although we have the object metadata
// locally, the object itself is frequently not cached so there will be nothing
// to discard.

// Directories pose a problem since the last-modified date in the header is
// when the directory was created, not when new entries were added to the
// directory. We can't use this date as the mtime, since that breaks NFS
// client-side caching. The client will assume the directory has not changed.
// Thus, for directories, we track a seperate last_modified property on the
// local metadata stats which is then used as the mtime. This value is
// initially the header's last-modified value, but if we later determine that
// the directory info is stale and we reload it from Manta, we update the
// last_modified value to be the time we reloaded. In this way, the mtime on a
// directory can change and NFS clients can detect when they need to reread the
// entire directory from the server.

// When the server starts up each object we have cached locally will be checked
// to be sure it is not stale.

// For cache size handling, when we see that pulling data into the cache will
// exceed our size limit, we iterate the LRU in reverse order (i.e. oldest
// first) to remove files from the cache. We maintain a lot more object
// metadata locally than we cache the objects themselves, so many of the
// entries in the LRU won't have a cached object associated with them. We can't
// use the LRU size limit and length functions to track local objects since we
// always put object metadata into the LRU cache but we don't always have a
// copy of the object downloaded. The length method is only called when we
// insert into the LRU so we don't have a way to change the length when we
// finally download, enlarge, or evict the object itself.

// WRITEBACK

// The data we track for writeback is used to ensure that we never miss
// writing a file back to Manta. There are several tricky considerations here.
//
// The 'wbtime' configuration value is used to indicate how long a file can
// be dirty in the cache before we schedule a writeback. 'wbtime' is not a
// quarantee as to when the writeback will occur since other writeback activity
// can delay when the file is actually written back.
//
// We need to ensure that a file which is being written to on a regular basis
// is not starved from ever being written back. We need to ensure that if we
// are restarted while the file is dirty, that the file gets scheduled for
// writeback. We also don't want to writeback the file more times than is
// necessary (i.e. writeback should coalesce as much write activity as
// possible) but we need to handle the case where the file is updated while
// in the middle of a writeback.
//
// Writeback tracking is managed as follows:
// 1) Every time we write to the file, we update the file's dirty timestamp
//    in the DB. In this way, if we restart, we will schedule a writeback
//    for the file in, at most, 'wbtime' after the restart. If the server was
//    down for longer than 'wbtime', then the writeback can be scheduled
//    immediately.
// 2) We use an in-memory list (wb_pending) to also track writeback scheduling.
//    The first time we write to a file, we add the file to the list (using the
//    current time value). On subsequent writes, if the file is already in the
//    list, we don't make any change. This ensures that the file's writeback is
//    not starved by subsequent writes.
// 3) The writeback scheduling uses the in-memory wb_pending list to determine
//    which files to writeback. When the writeback is running, it processes
//    this list and writes back each file that has been on the list for at
//    least 'wbtime'. At the start of writing back a file, the file is removed
//    from the pending list. This ensures that any subsequent writes to the
//    file are rescheduled for a future writeback (since we don't have any way
//    to tell if the write was to a portion of the file which was already
//    uploaded). While the file is being written back, it is stored on the
//    in-memory wb_inprogress list. The inprogress list is also used to track a
//    deferred file operation (e.g. removal, truncation, etc.) while the file
//    is being uploaded. The deferred operation will be run when the upload has
//    finished.
// 4) When the file has completed writing back, we check the wb_pending list
//    to see if the file was modified while we were writing back (i.e. if a
//    new entry exists for the file, since we removed the entry when we started
//    writing back). If not, then we delete the DB record for the file since
//    it is no longer dirty.

// writeback is enabled when we have dirty files
var writeback_enabled = false;
// our in-memory list of dirty files
var wb_pending = {};
// our in-memory list of files that are currently being written back; also
// tracks a deferred operation on that file
var wb_inprogress = {};
// the number of concurrently running writebacks
var wb_num = 0;

// set when we're doing an async eviction
var eviction_running = false;

///--- Helpers

function bytes(mb) {
    assert.number(mb, 'megabytes');

    return (Math.floor(mb * 1024  *1024));
}


function errno(err, syscall) {
    // TODO
    var code = 'EIO';

    return (new ErrnoError(code, syscall || 'leveldb', err));
}


function MB(b) {
    assert.number(b, 'bytes');

    return (Math.floor(b / 1024 /1024));
}


/**
 * This function drives the writeback of dirty files.
 *
 * Writeback of dirty files is normally asynchronous. It is initiated on
 * startup if we have dirty files in the DB and its scheduled by the 'dirty'
 * function if necessary. Dirty files are held in the local cache for a period
 * of time before being written back.
 *
 * This function also calls itself when a writeback has completed to see if
 * there is more work to do.
 *
 * The _writeback function is normally called with no arguments and simply
 * processes the list of dirty files to upload the ones which have aged out.
 * However, if called explicitly with a filename and callback, then it will
 * immediately upload that file (if its dirty) and then run the callback.
 */
function _writeback(immediate_file, cb) {
    assert.optionalString(immediate_file, 'immediate_file');
    assert.optionalFunc(cb, 'callback');

    var log = this.log;
    var self = this;

    function _doUpload(_arg, _cb) {
        var cachefile = path.join(self.location, 'fscache', _arg.cachefile);
        log.debug('writeback %s => %s', _arg.cachefile, _arg.fname);

        fs.stat(cachefile, function onStatDone(s_err, stats) {
            if (s_err) {
                // This should never happen
                log.error(s_err, '_doUpload(%s): error stat-ing local ' +
                    'file (%s)', _arg.fname, cachefile);
                _cb(s_err, _arg);
                return;
            }

            // Only read the current size in case the file gets extended
            // while we're uploading. In that case it will be dirty again
            // and be re-uploaded.
            var rd_size = stats.size;
            if (rd_size > 0)
                rd_size -= 1;
            var r_opts = {
                start: 0,
                end: rd_size
            };
            var m_opts = {
                size: stats.size
            };
            var rstream = fs.createReadStream(cachefile, r_opts);
            rstream.once('error', function onFileError(err) {
                log.error(err, '_doUpload(%s): error reading from local ' +
                    'file (%s)', _arg.fname, cachefile);
                _cb(err, _arg);
            });

            rstream.once('open', function onOpen() {
                self.manta.put(manta.path(_arg.fname, true), rstream, m_opts,
                  function (err) {
                    if (err) {
                        log.error(err, '_doUpload(%s): error pushing (%s) ' +
                            'to manta:', _arg.fname, cachefile);
                        _cb(err, _arg);
                    } else {
                        log.debug('_doUpload(%s) pushed to (%s):',
                            cachefile, _arg.fname);
                        _cb(null, _arg);
                    }
                });
            });
        });
    }

    function _fileUploaded(_arg, _cb) {
        if (!wb_pending[_arg.fname]) {
            // if no more writes while we were uploading, we remove it from
            // the DB since its no longer dirty
            var key = sprintf(DIRTY_KEY_FMT, _arg.fname);
            self.db.batch()
                .del(key)
                .write(function onBatchDel(err) {
                    if (err) {
                        log.warn(err, 'dirty del(%s): failed', _arg.fname);
                        _cb(errno(err, _arg));
                    } else {
                        log.trace('dirty del(%s): done', _arg.fname);
                        _cb(null, _arg);
                    }
                });
        }
    }

    function _updateLastMod(_arg, _cb) {
        // Update the last modified time for this file into the cache.
        // Ignore errors here since this can only impact our view of when the
        // file is stale.
        self.get(_arg.fname, function (err, info) {
            if (err) {
                _cb(null, _arg);
                return;
            }

            var upd = new Date();
            info.headers['last-modified'] = upd.toUTCString();
            info.last_stat = upd.getTime();

            self.put(_arg.fname, info, function (err2) {
                _cb(null, _arg);
            });
        });
    }

    function _wb_done(err, res) {
        // just use the return from the first operation to get the args
        var args = res.operations[0].result;
        if (err) {
            log.error(err, 'writeback: error %s', args.fname);
            // XXX JJ generalize error handling
            // e.g. if (err.code === 'UploadTimeout') ...
            // other manta errors, etc.
            // On upload timeout we won't have called the _fileUploaded
            // function in the pipeline, so we still have the file in the DB,
            // but not the wb_pending list. We'll add this entry back into the
            // in-memory wb_pending list (or overwrite the existing entry if
            // the file was updated while we tried to upload), but with a
            // timestamp one minute in the future, so that we'll retry the
            // upload of this file a little later. We still keep trying to
            // upload any other files in the list. This handles the case in
            // which the failure was somehow relevant only to this file. If all
            // uploads fail, we'll have just added them back to the writeback
            // list for future retries.
            var plusminute = new Date().getTime();
            plusminute += 60000;
            wb_pending[args.fname] = {
                cachefile: args.cachefile,
                timestamp: plusminute
            };
        } else {
            log.debug('writeback %s done', args.fname);
        }

        var pending_op = wb_inprogress[args.fname].op;
        var pending_cb = wb_inprogress[args.fname].cb;
        var pending_info = wb_inprogress[args.fname].info;
        // remove it from the in-memory inprogress list
        delete wb_inprogress[args.fname];
        wb_num--;

        if (pending_op) {
            log.debug('writeback %s, pending %s', args.fname, pending_op);

            // We had to block an operation while the upload was in progress.
            // Perform that operation now and schedule _writeback to continue.
            setTimeout(_writeback.bind(self), 1);
            if (pending_op === 'del') {
                self.del(args.fname, pending_cb);
            } else if (pending_op === 'trunc') {
                self.truncate(args.fname, pending_info, pending_cb);
            } else if (pending_op === 'cb') {
                pending_cb();
            } else {
                log.error('writeback %s, pending %s unknown',
                    args.fname, pending_op);
            }
        } else {
            // this is the normal path, just take another lap
            var wb = _writeback.bind(self);
            wb();
        }
    }

    if (immediate_file) {
        if (wb_pending[immediate_file]) {
            // the file is dirty, upload it now
            log.debug('_writeback immd. %s: pending', immediate_file);

            file_data = {
                fname: immediate_file,
                cachefile: wb_pending[immediate_file].cachefile
            };

            // remove it from the in-memory list
            delete wb_pending[immediate_file];

            // add it to the in-memory in progress list with cb pending
            wb_inprogress[immediate_file] = {
                op: 'cb',
                cb: cb
            };
            wb_num++;

            // here is where we setup the writeback pipeline
            vasync.pipeline({
                funcs: [
                    _doUpload,
                    _fileUploaded,
                    _updateLastMod
                ],
                arg: file_data
            }, _wb_done);

        } else if (wb_inprogress[immediate_file]) {
            // the file is already being uploaded now, setup cb
            if (wb_inprogress[immediate_file].op) {
                // there shouldn't be any pending op in this case
                log.error('writeback immd. %s: already pending %s',
                    immediate_file, wb_inprogress[immediate_file].op);
            }
            log.debug('_writeback immd. %s: in progress', immediate_file);
            wb_inprogress[immediate_file] = {
                op: 'cb',
                cb: cb
            };
        } else {
            // the file is not dirty and not being uploaded, just run cb
            log.debug('_writeback immd. %s: do nothing', immediate_file);
            cb(null);
        }

        return;
    }

    var now = new Date().getTime();
    var threshold = now - self.wbtime;

    // When we iterate using 'in', the elements in wb_pending are probably
    // ordered by the order in which they were defined. On startup, when
    // pulling out of the DB, we define them in the order we get them from the
    // DB which, since its a btree, will be alphabetical. Thus, we have to look
    // at each entry to see if its time to write it back. That is, the entries
    // might not be in timestamp order so we can't stop when we see an entry
    // that's not ready to be written back.
    //
    // Once we start processing the list, we'll get called back and keep making
    // a pass over the list until we have made a full pass with no writeback.
    // At that time, if there are still elements in the list, we schedule
    // ourselves to wakeup later and process the list again.

    var wb_running = false;
    var more_files = false;
    var fname;
    var file_data = {};
    for (fname in wb_pending) {
        if (threshold > wb_pending[fname].timestamp) {
            if (wb_inprogress[fname]) {
                // This file is still in the middle of an upload and its dirty
                // again and time to writeback again. We skip this file until
                // the current upload finishes and we come back around.
                continue;
            }

            file_data = {
                fname: fname,
                cachefile: wb_pending[fname].cachefile
            };

            // remove it from the in-memory list
            delete wb_pending[fname];

            // add it to the in-memory in progress list with nothing pending
            wb_inprogress[fname] = {};
            wb_num++;
            wb_running = true;

            // here is where we setup the writeback pipeline
            vasync.pipeline({
                funcs: [
                    _doUpload,
                    _fileUploaded,
                    _updateLastMod
                ],
                arg: file_data
            }, _wb_done);

            if (wb_num >= self.num_par) {
                // we've hit our limit for parallel writebacks, break out of
                // the loop since we'll callback to _writeback when one of the
                // uploads has finished
                break;
            }
        } else {
            more_files = true;
        }
    }

    if (!wb_running) {
        if (more_files) {
            setTimeout(_writeback.bind(self), self.wbtime);
        } else {
            writeback_enabled = false;
        }
    }
}


///--- API

function Cache(opts) {
    assert.object(opts, 'options');
    // assert.number(opts.dirty, 'options.dirty');
    assert.object(opts.log, 'options.log');
    assert.string(opts.location, 'options.location');
    assert.number(opts.size, 'options.size');
    assert.number(opts.ttl, 'options.ttl');
    assert.number(opts.wbtime, 'options.wbtime');
    assert.number(opts.num_par, 'options.num_par');

    events.EventEmitter.call(this, opts);

    // no maxAge means entries never age out on their own
    this.cache = LRU({
        max: Infinity // hacky - but we just want LRU bookeeping
    });

    this.current_size = 0;
    this.db = null;
    this.log = opts.log.child({
        component: 'MantaFsCache',
        location: path.normalize(opts.location)
    }, true);
    this.location = path.normalize(opts.location);
    this.max_size = opts.size;
    this.curr_size = 0;
    this.ttl_ms = opts.ttl * 1000;
    this.wbtime = opts.wbtime;
    this.num_par = opts.num_par;
    this.manta = opts.manta;

    this._mantafs_cache = true; // MDB flag

    // When we first startup we'll process any dirty files that might be left
    // in our cache during the open() function.
    this.open();
}
util.inherits(Cache, events.EventEmitter);
module.exports = Cache;



/**
 * This method simply indicates whether the data is in the local cache or not.
 *
 * When a caller knows that there is already somebody else performing
 * a download, rather than stomping all over each other, we just stack
 * up callers and wait for the data they need in the local cache file.
 *
 * `path` is the local cache file, not the manta path.
 * `pos` is the last byte of data to wait for.
 */
Cache.prototype.dataInCache = function dataInCache(p, pos, cb) {
    assert.string(p, 'path');
    assert.number(pos, 'position');
    assert.func(cb, 'callback');

    cb = once(cb);

    var log = this.log;
    var ok = false;

    log.trace('dataInCache(%s, %d): entered', p, pos);

    this.get(p, function onDbGet(err, info) {
        if (err) {
            log.error(err, 'dataInCache(%s): failed', p);
            cb(err);
        } else {
            if (!info) {
                log.error('dataInCache(%s): info is null', p);
                cb(errno('ENOENT', 'get'));
                return;
            }

            fs.stat(info._cacheFile, function onStatDone(err2, stats) {
                if (err2) {
                    if (err2.code !== 'ENOENT') {
                        log.trace(err2, 'dataInCache(%s): failed', p);
                        cb(err2);
                        return;
                    }
                    if (info.size === 0) {
                        fs.writeFile(p, new Buffer(0), function (err3) {
                            if (err) {
                                log.trace(err3,
                                          'dataInCache(%s): failed (truncate)',
                                          p);
                                cb(err);
                            } else {
                                log.trace('dataInCache(%s, %d): %j', p, pos,
                                          true);
                                cb(null, true, info);
                            }
                        });
                        return;
                    }
                } else {
                    ok = stats.size === info.size || stats.size >= pos;
                }

                log.trace('dataInCache(%s, %d): %j', p, pos, ok);
                cb(null, ok, info);
            });
        }
    });
};


/**
 * Mark a file as being dirty in the cache and needing to be written back
 * to Manta.
 *
 * `path` is the local cache file, not the manta path.
 */
Cache.prototype.dirty = function dirty(p, cachefile, cb) {
    assert.string(p, 'path');
    assert.string(cachefile, 'cachefile');
    assert.func(cb, 'callback');

    cb = once(cb);

    var self = this;
    var log = this.log;
    var k = sprintf(DIRTY_KEY_FMT, p);

    var now = new Date().getTime();
    var wb_data = {
        cachefile: cachefile,
        timestamp: now
    };
    if (!wb_pending[p]) {
        // first time being dirtied, add to in-memory lists
        wb_pending[p] = wb_data;
    }
    // make sure that writeback is enabled
    if (!writeback_enabled) {
        writeback_enabled = true;
        // schedule for 5ms after the timeout to be sure we writeback this
        // initial file in the list.
        setTimeout(_writeback.bind(self), self.wbtime + 5);
    }
    self.db.batch()
        .put(k, wb_data)
        .write(function onBatchWrite(err) {
            if (err) {
                log.warn(err, 'dirty put(%s): failed', p);
                cb(errno(err));
            } else {
                var changed = new Date(wb_data.timestamp);
                log.trace('dirty(%s) done => %s', p, changed.toUTCString());
                cb(null);
            }
        });
};


Cache.prototype.writeback_now = function writeback_now(p, cb) {
    assert.string(p, 'path');
    assert.func(cb, 'callback');

    var wb = _writeback.bind(this, p, cb);
    wb();
};


// This expects the caller to have already done the Manta ln.
// This code takes care of cleaning up the old existing data that might be in
// the cache and sets up the bookkeeping data for the new file.
// The new file keeps the old file's fhandle and is setup to point at the
// existing cached file.
Cache.prototype.mv = function mv(oldpath, newpath, cb) {
    assert.string(oldpath, 'oldpath');
    assert.string(newpath, 'newpath');
    assert.func(cb, 'callback');

    var self = this;
    var log = this.log;

    log.trace('cache mv(%s, %s): entered', oldpath, newpath);

    // We can't use self.put here since we need to force the use of the old
    // _fhandle and _cachefile; update the db directly.
    function update_db(p, stats, _cb) {
        var key = sprintf(FILES_KEY_FMT, p);
        var k1 = sprintf(FHANDLE_KEY_FMT, p);
        var k2 = sprintf(FNAME_KEY_FMT, stats._fhandle);

        self.db.batch()
            .put(key, stats)
            .put(k1, stats._fhandle)
            .put(k2, p)
            .write(function onBatchWrite(err2) {
                if (err2) {
                    log.error(err2, 'update_db(%s): failed', p);
                    _cb(errno(err2));
                } else {
                    log.trace('update_db(%s): done', p);
                    self.cache.set(key, stats);
                    _cb(null);
                }
            });
    }

    function cleanup() {
        self._del_on_rename(oldpath, function (d_err) {
            if (d_err) {
                log.error(d_err, 'mv del %s: failed', oldpath);
                cb(d_err);
                return;
            }

            self.add_to_pdir(newpath, function (p_err) {
                if (p_err) {
                    log.error(p_err, 'mv dirtyp %s: failed',
                        newpath);
                    cb(p_err);
                    return;
                }
                log.trace('cache mv(%s, %s): done', oldpath, newpath);
                cb(null);
            });
        });
    }

    self.get(oldpath, function (o_err, o_info) {
        if (o_err) {
            log.error(o_err, 'mv get (%s): failed', oldpath);
            cb(o_err);
            return;
        }

        if (o_info) {
            self.manta.stat(manta.path(newpath, true),
              function (m_err, n_info) {
                if (m_err) {
                    log.error(m_err, 'mv stat (%s): failed', newpath);
                    cb(m_err);
                    return;
                }

                n_info._fhandle = o_info._fhandle;
                n_info._cacheFile = o_info._cacheFile;
                n_info.last_stat = Date.now();

                // We can't use self.put here since we need to force the use
                // of the old _fhandle and _cachefile; update the db directly.
                update_db(newpath, n_info, function (u_err) {
                    if (u_err) {
                        cb(u_err);
                        return;
                    }
                    cleanup();
                });
            });
        } else {
            cleanup();
        }
    });
};


Cache.prototype.setEvict = function setEvict(p, val) {
    assert.string(p, 'path');
    assert.optionalBool(val, 'value');

    var k = sprintf(FILES_KEY_FMT, p);
    var stats = this.cache.get(k);

    if (stats) {
        if (val === false) {
            stats._no_evict = true;
        } else if (stats._no_evict) {
            delete stats._no_evict;
        }
    }
};


// Track additional space used when we are caching an object file. If we'll go
// over the cache size limit, initiate eviction to try to get us under the
// limit.
Cache.prototype._grow_cache = function _grow_cache(p, size) {
    assert.string(p, 'path');
    assert.number(size, 'size');

    var log = this.log;
    var self = this;

    // See if we have the object cached and try to evict it
    function process_entry(val, nextent) {
        if (!val || !val._tmp_pathname) {
            // if this is somehow missing, just skip it since we can't check
            // to see if the file is dirty
            nextent();
            return;
        }

        var nm = val._tmp_pathname;
        delete val._tmp_pathname;
        // if in-use or dirty, skip it
        if (val._no_evict || val._in_flight || wb_pending[nm] ||
          wb_inprogress[nm]) {
            nextent();
            return;
        }


        // if we've gotten under the limit, skip over the rest of the objects
        if (self.curr_size < self.max_size) {
            nextent();
            return;
        }

        fs.stat(val._cacheFile, function (serr, stats) {
            if (serr) {
                // just assume an error is ENOENT meaning object is not cached
                // this is common
                nextent();
                return;
            }

            // recheck after callback if in-use or dirty and skip it
            if (val._no_evict || val._in_flight || wb_pending[nm] ||
              wb_inprogress[nm]) {
                nextent();
                return;
            }

            fs.unlink(val._cacheFile, function (uerr) {
                // ignore errors deleting the cachefile but if no
                // error, that means we should adjust our size
                if (!uerr) {
                    self._reduce_cache(nm, stats.size);
                    log.trace('evicted(%s, %d): %d', nm, size, self.curr_size);
                }

                nextent();
            });
        });
    }

    function all_done() {
        if (self.curr_size > self.max_size)
            log.warn('eviction pass complete but still over limit: %d',
                self.curr_size);
        eviction_running = false;
    }

    if (!eviction_running && (this.curr_size + size) > this.max_size) {

        // Set the global flag for eviction in progress so we only do one
        // pass at a time.
        eviction_running = true;

        // Most of the metadata entries in the LRU cache won't have the actual
        // object cached in the file system. Also, iterating this array
        // won't cause any stale objects to drop out, so we can assume that
        // objects which are also cached in the file system will be seen. Its a
        // requirement that we don't change the LRU order or cause a stale
        // entry to drop out of the LRU cache. We reverse the order of the
        // array so we process it older->younger, which is how we want to
        // evict.
        var ka = this.cache.keys();
        var va = this.cache.values();
        ka.reverse();
        va.reverse();

        // When we initiate an eviction we need to know the full path to be
        // able to check for dirty files. Add this to the val as a temporary
        // property.
        for (var i = 0; i < va.length; i++) {
            var n = ka[i].substr(3);
            va[i]._tmp_pathname = n;
        }

        // Initiate async eviction; process all local files until we get
        // under the size limit.
        vasync.forEachPipeline({
            'func': process_entry,
            'inputs': va
        }, all_done);
    }
    log.trace('_grow_cache(%s, %d): %d', p, size, self.curr_size);
    self.curr_size += size;
};


Cache.prototype._reduce_cache = function _reduce_cache(p, size) {
    assert.string(p, 'path');
    assert.number(size, 'size');

    var log = this.log;

    log.trace('_reduce_cache(%s, %d): %d', p, size, this.curr_size);
    this.curr_size -= size;
    if (this.curr_size < 0)
        this.curr_size = 0;
};


// in-flight downloads (not uploads)
Cache.prototype.inFlight = function inFlight(p, val, size) {
    assert.string(p, 'path');
    assert.optionalBool(val, 'value');

    var self = this;

    var k = sprintf(FILES_KEY_FMT, p);
    var stats = this.cache.get(k);

    if (stats && val !== undefined) {
        if (val === true) {
            // There can be multiple calls to inFlight so we need to check
            // if this is the first one and only do space accounting once.
            if (!stats._in_flight) {
                assert.number(size, 'size');
                self._grow_cache(p, size);
            }

            stats._in_flight = true;
        } else if (val === false && stats._in_flight) {
            delete stats._in_flight;
        }
    }

    return ((stats || {})._in_flight || false);
};


Cache.prototype.fhandle = function fhandle(fh, cb) {
    assert.string(fh, 'path');
    assert.func(cb, 'callback');

    cb = once(cb);

    var k = sprintf(FNAME_KEY_FMT, fh);
    var log = this.log;

    log.trace('fhandle(%s): entered', fh);
    this.db.get(k, function onDbGet(err, val) {
        if (err) {
            log.trace(err, 'fhandle(%s): error', fh);
            cb(errno(err, 'fhandle'));
        } else {
            log.trace('fhandle(%s): done => %s', fh, val);
            cb(null, val);
        }
    });
};


Cache.prototype.lookup = function lookup(p, cb) {
    assert.string(p, 'path');
    assert.func(cb, 'callback');

    cb = once(cb);

    var k = sprintf(FHANDLE_KEY_FMT, p);
    var log = this.log;

    log.trace('lookup(%s): entered', p);
    this.db.get(k, function onDbGet(err, val) {
        if (err) {
            log.trace(err, 'lookup(%s): error', p);
            cb(errno(err, 'lookup'));
        } else {
            log.trace('lookup(%s): done => %s', p, val);
            cb(null, val);
        }
    });
};


// Check if the cached info we have is stale compared to what manta has. Also
// return the info we got from manta.
Cache.prototype._cached_info_stale =
  function _cached_info_stale(p, c_info, cb) {
    assert.string(p, 'path');
    assert.object(c_info, 'c_info');
    assert.func(cb, 'callback');

    var log = this.log;
    var self = this;

    cb = once(cb);

    self.manta.stat(manta.path(p, true), function onStatDone(err, m_info) {
        if (err) {
            if (err.code === 'ENOENT') {
                log.trace('get manta stat (%s): noent', p);
                cb(null, true, c_info);
            } else {
                log.error(err, 'get manta stat (%s): failed', p);
                cb(err);
            }
            return;
        }

        var stale = false;
        if (c_info.extension === 'directory') {
            var c_n_ents = c_info.headers['result-set-size'];
            var m_n_ents = m_info.headers['result-set-size'];
            // This is not ideal since the dir contents could have changed but
            // still have the same number of entries, but its the best we can do
            // since the last-modified date on a directory object is the date on
            // which it was created.
            if (c_n_ents !== m_n_ents) {
                // update last_modified date for stale direcory
                var md = new Date();
                m_info.last_modified = md.toUTCString();
                stale = true;
            } else {
                m_info.last_modified = c_info.last_modified;
            }
        } else {
            var c_date = new Date(c_info.headers['last-modified']);
            var m_date = new Date(m_info.headers['last-modified']);
            if (c_info.size !== m_info.size || c_date < m_date)
                stale = true;
        }

        m_info._fhandle = c_info._fhandle;
        m_info._cacheFile = c_info._cacheFile;
        m_info.last_stat = Date.now();
        cb(null, stale, m_info);
    });
};


Cache.prototype.has = function has(p) {
    return (this.cache.has(sprintf(FILES_KEY_FMT, p)));
};


Cache.prototype.get = function get(p, cb) {
    assert.string(p, 'path');
    assert.func(cb, 'callback');

    cb = once(cb);

    var key = sprintf(FILES_KEY_FMT, p);
    var log = this.log;
    var self = this;

    log.trace('get(%s): entered', p);

    var _stats = this.cache.get(key);
    if (!_stats) {
        log.trace('get(%s): miss', p);
        cb(null, null);
        return;
    }

    // check if cached copy is expired
    if (_stats.last_stat && (Date.now() - _stats.last_stat) <= self.ttl_ms) {
        setImmediate(function onGetFileCacheDone() {
            log.trace('get(%s): done (cached) => %j', p, _stats);
            cb(null, _stats);
        });
        return;
    }

    // We need to go recheck manta to see if the object is stale.
    self._cached_info_stale(p, _stats, function (m_err, stale, m_info) {
        if (m_err) {
            cb(m_err);
            return;
        }

        if (stale) {
            log.trace('get(%s): stale, invalidate', p);
            self._invalidate(p, m_info, cb);
        } else {
            // update the DB and LRU cache with the new last_stat time
            self.put(p, m_info, cb);
        }
    });
};


// We always guarantee the incoming stats will get the correct _fhandle and
// _cacheFile properties and we return a stats which has these set correctly.
Cache.prototype.put = function put(p, stats, cb) {
    assert.string(p, 'path');
    assert.object(stats, 'stats');
    assert.func(cb, 'callback');

    cb = once(cb);

    var log = this.log;
    var self = this;

    log.trace('put(%s, %j): entered', p, stats);

    var key = sprintf(FILES_KEY_FMT, p);
    var val = this.cache.get(key);
    if (val) {
        stats._fhandle = val._fhandle;
        stats._cacheFile = val._cacheFile;
    } else {
        stats._fhandle = uuid.v4();
        stats._cacheFile = path.join(self.location, 'fscache', stats._fhandle);

        if (stats.extension === 'directory') {
            // This is a directory which we've never had cached before. See the
            // big theory comment for why we set last_modified.
            if (stats.headers['last-modified']) {
                stats.last_modified = stats.headers['last-modified'];
            } else {
                var md = new Date();
                stats.last_modified = md.toUTCString();
            }
        }
    }

    if (!stats.last_stat) {
        stats.last_stat = Date.now();
    }

    var k1 = sprintf(FHANDLE_KEY_FMT, p);
    var k2 = sprintf(FNAME_KEY_FMT, stats._fhandle);

    self.db.batch()
        .put(key, stats)
        .put(k1, stats._fhandle)
        .put(k2, p)
        .write(function onBatchWrite(err2) {
            if (err2) {
                log.trace(err2, 'put(%s): failed', p);
                cb(errno(err2));
            } else {
                log.trace('put(%s): done', p);
                self.cache.set(key, stats);
                cb(null, stats);
            }
        });
};

// Removing a file from the cache is complicated by the interaction with
// writeback. If the file is pending writeback, we can cleanup the bookkeeping
// immediately and the file will never get written back. However, if the
// file is in the middle of being written back, we cannot remove the file
// until that operation has completed.
Cache.prototype.del = function del(p, cb) {
    assert.string(p, 'path');
    assert.func(cb, 'callback');

    cb = once(cb);

    var log = this.log;
    var self = this;

    // remove from manta
    function cleanup_manta(_cb) {
        self.manta.unlink(manta.path(p, true), function (m_err) {
            if (m_err) {
                // An ENOENT is ok since that means the file doesn't
                // exist in manta. This can happen if we create and delete a
                // file before we ever write it back.
                if (m_err.code === 'ENOENT') {
                    log.trace('del(%s): done', p);
                    _cb(null);
                } else {
                    if (m_err.code === 'ENOTEMPTY') {
                        log.info('del(%s): directory not empty', p);
                    } else {
                        log.error(m_err, 'del(%s): failed', p);
                    }
                    _cb(m_err);
                }
            } else {
                log.trace('del(%s): done', p);
                _cb(null);
            }
        });
    }

    function cleanup_cache(_fhandle, size, _cb) {
        var key = sprintf(FILES_KEY_FMT, p);
        var fhk = sprintf(FHANDLE_KEY_FMT, p);
        var fnk = sprintf(FNAME_KEY_FMT, _fhandle);
        var dtk = sprintf(DIRTY_KEY_FMT, p);
        self.db.batch()
            .del(key)
            .del(fhk)
            .del(fnk)
            .del(dtk)
            .write(function onBatchDel(err2) {
                if (err2) {
                    log.error(err2, 'del(%s): failed', p);
                    _cb(errno(err2));
                } else {
                    // remove from LRU cache
                    self.cache.del(key);

                    var cachefile = path.join(self.location, 'fscache',
                        _fhandle);
                    fs.unlink(cachefile, function (u_err) {
                        // ignore errors deleting the cachefile but if no
                        // error, that means we should adjust our size
                        if (!u_err)
                            self._reduce_cache(p, size);

                        // cleaned up locally, now remove from manta
                        cleanup_manta(_cb);
                    });
                }
            });
    }

    log.trace('del(%s): entered', p);
    this.get(p, function (err, info) {
        if (err) {
            log.error(err, 'del(%s): failed', p);
            cb(err);
            return;
        }

        if (!info) {
            cb();
            return;
        }

        if (info.extension === 'directory') {
            // We can do a directory immediately since no writeback. We rely on
            // the caller to check that the directory is empty before calling
            // us so we can assume the directory object size is 0.
            self._rm_from_pdir(p, function (r_err) {
                if (r_err) {
                    log.error(r_err, 'del rm_from_pdir (%s): failed', p);
                    cb(r_err);
                    return;
                 }

                 cleanup_cache(info._fhandle, 0, cb);
            });
        } else {
            // For a plain file we have to manage the interaction with
            // writeback.
            if (wb_inprogress[p]) {
                 // we can't delete the file while it is being written
                 // back, setup to delete when upload is done
                 log.debug('del(%s): postponed', p);
                 wb_inprogress[p] = {
                     op: 'del',
                     cb: cb
                 };
                 return;
            }

            if (wb_pending[p]) {
                // remove it from the writeback in-memory list
                delete wb_pending[p];
            }

            self._rm_from_pdir(p, function (r_err) {
                if (r_err) {
                    log.error(r_err, 'del rm_from_pdir (%s): failed', p);
                    cb(r_err);
                    return;
                 }

                 cleanup_cache(info._fhandle, info.size, cb);
            });
        }
    });
};


// This function is based on the 'del' function but is only used during
// rename when we have to cleanup part of the old file data but leave parts
// of it in place. We don't have to worry about writeback here since the file
// was written back before we continued with the rename.
Cache.prototype._del_on_rename = function _del_on_rename(p, cb) {
    assert.string(p, 'path');
    assert.func(cb, 'callback');

    cb = once(cb);

    var log = this.log;
    var self = this;

    // remove from manta
    function cleanup_manta(_cb) {
        self.manta.unlink(manta.path(p, true), function (m_err) {
            if (m_err) {
                log.error(m_err, '_del_on_rename(%s): failed', p);
                _cb(m_err);
            } else {
                log.trace('_del_on_rename(%s): done', p);
                _cb(null);
            }
        });
    }

    function cleanup_cache(_cb) {
        var key = sprintf(FILES_KEY_FMT, p);
        var fhk = sprintf(FHANDLE_KEY_FMT, p);
        // we can't delete the FNAME_KEY_FMT entry since that is already
        // setup to refer to the renamed file
        self.db.batch()
            .del(key)
            .del(fhk)
            .write(function onBatchDel(err) {
                if (err) {
                    log.error(err, '_del_on_rename(%s): failed', p);
                    _cb(errno(err));
                } else {
                    // remove from LRU cache
                    self.cache.del(key);
                    cleanup_manta(_cb);
                }
            });
    }

    log.trace('_del_on_rename(%s): entered', p);
    self._rm_from_pdir(p, function (r_err) {
        if (r_err) {
            log.error(r_err, '_del_on_rename rm_from_pdir (%s): failed', p);
            cb(r_err);
            return;
        }

        cleanup_cache(cb);
    });
};


// Check the cached file to see if it is stale. If it is, delete the cached
// file so that we re-download it from Manta on the next access.
Cache.prototype.refresh = function refresh(p, cb) {
    assert.string(p, 'p');
    assert.func(cb, 'callback');

    var log = this.log;
    var self = this;

    log.trace('refresh(%s): entered', p);
    self.get(p, function (err, c_info) {
        if (err) {
            log.error(err, 'refresh cache get (%s): failed', p);
            err.syscall = 'stat';
            cb(err);
            return;
        }

        if (!c_info) {
            log.trace('refresh(%s): not cached, done', p);
            cb(null);
            return;
        }

        self._cached_info_stale(p, c_info, function (err2, stale, m_info) {
            if (err2) {
                 cb(err2);
                 return;
            }

            if (stale) {
                log.trace('refresh (%s): stale, invalidate', p);
                self._invalidate(p, m_info, cb);
            } else {
                log.trace('refresh(%s): not stale, done', p);
                cb(null);
            }
        });
    });
};

// Invalidate a local file in the cache so that we will refetch it from Manta.
// This also updates the cached stats info for the object and returns those
// stats.
Cache.prototype._invalidate = function _invalidate(p, m_info, cb) {
    assert.string(p, 'path');
    assert.object(m_info, 'm_info');
    assert.func(cb, 'callback');

    assert.string(m_info._fhandle, '_fhandle');
    assert.string(m_info._cacheFile, '_cacheFile');

    cb = once(cb);

    var log = this.log;
    var self = this;

    log.trace('invalidate(%s): entered', p);

    if (wb_pending[p] || wb_inprogress[p]) {
        // assume that things will be ok when the upload is done, just return
        log.trace('invalidate(%s): writing back; done', p);
        cb(null, m_info);
        return;
    }

    var size;
    if (m_info.extension === 'directory') {
        // We don't really know the size of the directory object unless we stat
        // the cached file. We always just hardcode an estimate of the size of
        // a directory object.
        size = 5000;
    } else {
        size = m_info.size;
    }
    assert.number(size, 'size');
    var key = sprintf(FILES_KEY_FMT, p);

    self.db.batch()
        // we only need to update the info data in the db and lru cache
        .put(key, m_info)
        .write(function onBatchWrite(err2) {
            if (err2) {
                log.error(err2, 'invalidate put(%s): failed', p);
                cb(errno(err2));
                return;
            }

            log.trace('put(%s): done', p);
            self.cache.set(key, m_info);

            var cachefile = path.join(self.location, 'fscache',
                m_info._fhandle);
            fs.unlink(cachefile, function (u_err) {
                // ignore errors deleting the cachefile but if no error, that
                // means we should adjust our size
                if (!u_err)
                    self._reduce_cache(p, size);

                log.trace('invalidate(%s): done', p);
                cb(null, m_info);
            });
        });
};


// Remove given entry from cached parent directory
Cache.prototype._rm_from_pdir = function _rm_from_pdir(p, cb) {
    assert.string(p, 'path');
    assert.func(cb, 'callback');

    cb = once(cb);

    var log = this.log;
    var self = this;
    var name = path.basename(p);
    var dir = path.dirname(p);

    log.trace('_rm_from_pdir(%s): entered', p);

    this.get(dir, function (perr, pinfo) {
        if (perr || !(pinfo || {})._cacheFile) {
            log.trace(perr, '_rm_from_pdir(%s): parent not cached, done', p);
            cb();
            return;
        }

        var md = new Date();
        pinfo.last_modified = md.toUTCString();

        self.put(dir, pinfo, function (err2) {
            if (err2) {
                log.trace(err2, '_rm_from_pdir(%s): failed', p);
                cb(err2);
                return;
            }


            fs.stat(pinfo._cacheFile, function (serr, stats) {
                if (serr) {
                    if (serr.code === 'ENOENT') {
                        log.trace('_rm_from_pdir(%s): parent not cached, done',
                            p);
                        cb();
                    } else {
                        log.trace(serr, '_rm_from_pdir(%s): failed', p);
                        cb(serr);
                    }
                    return;
                }

                var lstream = new LineStream({
                    encoding: 'utf8'
                });
                var rstream = fs.createReadStream(pinfo._cacheFile, {
                    encoding: 'utf8'
                });
                var tmp = pinfo._cacheFile + '.tmp';
                var wstream = fs.createWriteStream(tmp, {
                    encoding: 'utf8'
                });

                function _cb(err) {
                    if (err) {
                        log.trace(err, '_rm_from_pdir(%s): failed', p);
                        cb(err);
                    } else {
                        log.trace('undirtParent(%s): done', p);
                    }
                }
                lstream.once('error', _cb);
                rstream.once('error', _cb);
                wstream.once('error', _cb);

                // We want to write everything except for the current key
                lstream.on('data', function onDirectoryLine(line) {
                    if (!line)
                        return;

                    try {
                        var data = JSON.parse(line);
                        if (data.name === name) {
                            self._reduce_cache(path.dirname(p), line.length);
                            return;
                        }
                    } catch (e) {
                        log.trace(e, '_rm_from_pdir(%s): cache data corruption',
                            p);
                        _cb(e);
                        return;
                    }

                    if (!wstream.write(line + '\n')) {
                        wstream.once('drain', lstream.resume.bind(lstream));
                        lstream.pause();
                    }
                });

                lstream.once('end', function onDirectoryEnd() {
                    wstream.once('finish', function onFlush() {
                        fs.rename(tmp, pinfo._cacheFile,
                          function onRename(rerr) {
                            if (rerr) {
                                log.trace(rerr, '_rm_from_pdir(%s): failed', p);
                                cb(rerr);
                            } else {
                                log.trace('_rm_from_pdir(%s): done', p);
                                cb();
                            }
                        });
                    });
                    wstream.end();
                });

                rstream.pipe(lstream);
            });
        });
    });
};


// When we read a directory object in for the first time, we can use the
// directory entries to pre-populate the DB and LRU stat caches. This makes
// subsequent operations to look at the directory elements go a lot faster
// since we don't have to stat each element into the cache. We never return
// an error since this is just a performance optimization.
Cache.prototype.load_cache_from_dir = function load_cache_from_dir(p, cb) {
    assert.string(p, 'path');
    assert.func(cb, 'callback');

    cb = once(cb);

    var log = this.log;
    var self = this;
    var now = Date.now();

    log.trace('load_cache_from_dir(%s): entered', p);

    // called with a directory entry as the arg
    function _prepopulate_metadata(_arg, _cb) {
        var entry;
        try {
            entry = JSON.parse(_arg);
        } catch (e) {
            _cb();
            return;
        }

        var nm = path.join(entry.parent, entry.name);

        var k = sprintf(FILES_KEY_FMT, nm);

        // if already in LRU cache, return
        var stats = self.cache.get(k);
        if (stats) {
            _cb();
            return;
        }

        self.db.get(k, function (err, val) {
            // if already in db, return
            if (!err) {
                _cb();
                return;
            }

            var fh = uuid.v4();
            var info;
            var cfile = path.join(self.location, 'fscache', fh);
            if (entry.type !== 'directory') {
                info = {
                    name: entry.name,
                    extension: 'bin',
                    type: 'application/octet-stream',
                    size: entry.size,
                    headers: {
                        'last-modified': entry.mtime
                    },
                    _fhandle: fh,
                    _cacheFile: cfile,
                    last_stat: now
                };

            } else {
                info = {
                    name: entry.name,
                    extension: 'directory',
                    type: 'application/x-json-stream; type=directory',
                    headers: {
                        'last-modified': entry.mtime,
                        'result-set-size': 3
                    },
                    last_modified: entry.mtime,
                    _fhandle: fh,
                    _cacheFile: cfile,
                    last_stat: now
                };
            }

            var k1 = sprintf(FHANDLE_KEY_FMT, nm);
            var k2 = sprintf(FNAME_KEY_FMT, fh);

            self.db.batch()
                .put(k, info)
                .put(k1, fh)
                .put(k2, nm)
                .write(function (err2) {
                    if (!err2)
                        self.cache.set(k, info);
                    _cb();
                });
        });
    }

    this.get(p, function (perr, pinfo) {
        if (perr || !(pinfo || {})._cacheFile) {
            log.trace(perr, 'load_cache_from_dir(%s): dir not cached, done', p);
            cb();
            return;
        }

        fs.stat(pinfo._cacheFile, function (serr, stats) {
            if (serr) {
                log.trace(serr, 'load_cache_from_dir(%s): failed', p);
                cb();
                return;
            }

            var entries = [];

            var lstream = new LineStream({
                encoding: 'utf8'
            });
            var rstream = fs.createReadStream(pinfo._cacheFile, {
                encoding: 'utf8'
            });

            function _cb(err) {
                if (err) {
                    cb();
                }
            }
            lstream.once('error', _cb);
            rstream.once('error', _cb);

            lstream.on('data', function onDirectoryLine(line) {
                if (!line)
                    return;

                entries.push(line);
            });

            lstream.once('end', function onDirectoryEnd() {
                vasync.forEachParallel({
                    func: _prepopulate_metadata,
                    inputs: entries
                }, cb);
            });

            rstream.pipe(lstream);
        });
    });
};


// Truncating a file in the cache is complicated by the interaction with
// writeback. If the file is pending writeback, we can truncate immediately and
// the file will get written back with the new size. However, if the file is in
// the middle of being written back, we cannot truncate the file until that
// operation has completed.
Cache.prototype.truncate = function truncate(p, info, cb) {
    assert.string(p, 'path');
    assert.object(info, 'info');
    assert.func(cb, 'callback');

    cb = once(cb);

    var log = this.log;
    var self = this;

    log.trace('cache truncate(%s): entered', p);
    if (wb_inprogress[p]) {
        // we can't truncate the file while it is being written back, setup to
        // truncate when upload is done
        log.debug('cache truncate(%s): postponed', p);
        wb_inprogress[p] = {
            op: 'trunc',
            info: info,
            cb: cb
        };
        return;
    }

    fs.truncate(info._cacheFile, function (t_err) {
        if (t_err) {
            log.error(t_err, 'cache truncate(%s): failed (fs)',
                info._cacheFile);
            cb(t_err);
            return;
        }

        self._reduce_cache(p, info.size);

        // mark file as dirty in the cache
        self.dirty(p, info._fhandle, function (d_err) {
            if (d_err) {
                log.error(d_err, 'dirty(%s): failed', p);
                cb(d_err);
            } else {
                log.trace('cache truncate(%s): done', p);
                cb(null);
            }
        });
    });
};


Cache.prototype.readdir = function readdir(p, cb) {
    assert.string(p, 'path');
    assert.func(cb, 'callback');

    cb = once(cb);

    var log = this.log;

    log.trace('readdir(%s): entered', p);

    this.get(p, function onDBGet(err, val) {
        if (err) {
            log.trace(err, 'readdir(%s): failed (DB)', p);
            cb(errno(err, 'readdir'));
            return;
        }

        var fstream = fs.createReadStream(val._cacheFile);

        fstream.once('error', function onError(err2) {
            cb(err2.code === 'ENOENT' ? null : err2, null);
        });
        fstream.once('open', function onOpen() {
            var dstream = new DirStream({encoding: 'utf8'});
            var lstream = new LineStream({encoding: 'utf8'});

            fstream.pipe(lstream).pipe(dstream);
            log.trace('readdir(%s): done (returning stream)', p);
            cb(null, dstream);
        });
    });
};


/**
 * When a caller creates dirty data, we need to record an entry in the (cached)
 * parent directory.  It is assumed that the caller knows the parent directory
 * is already in the cache. If it isn't, you get an error.
 *
 */
Cache.prototype.add_to_pdir = function add_to_pdir(p, cb) {
    assert.string(p, 'path');
    assert.func(cb, 'callback');

    cb = once(cb);

    var dir = path.dirname(p);
    var log = this.log;
    var self = this;

    log.trace('add_to_pdir(%s): entered', p);

    this.get(dir, function (p_err, p_info) {
        if (p_err) {
            log.trace(p_err, 'add_to_pdir(%s): failed', p);
            cb(p_err);
            return;
        }

        self.get(p, function (err, info) {
            if (err) {
                log.trace(err, 'add_to_pdir(%s): failed', p);
                cb(err);
                return;
            }

            var md = new Date();
            p_info.last_modified = md.toUTCString();

            self.put(dir, p_info, function (err2) {
                if (err2) {
                    log.trace(err2, 'add_to_pdir(%s): failed', p);
                    cb(err2);
                    return;
                }

                var entry = {
                    name: path.basename(p),
                    type: info.extension === 'directory' ?
                        'directory' : 'object',
                    mtime: new Date().toJSON(),
                    parent: dir
                };
                if (info.extension !== 'directory')
                    entry.size = info.size;
                var data = JSON.stringify(entry) + '\n';
                self._grow_cache(dir, data.length);
                var fname = p_info._cacheFile;

                // Note here if the directory was *not* fully cached, we're
                // ensuring the semantics of `ls` are to return only the dirty
                // data, which is likely not what the user wants, but for speed
                // this is what we currently do. If it turns out this is a
                // problem, we'll want the API layer to ensure the parent dir
                // is fully brought down
                fs.appendFile(fname, data, {encoding: 'utf8'}, function (err1) {
                    if (err1) {
                        log.trace(err1, 'add_to_pdir(%s): failed (append)', p);
                        cb(err1);
                    } else {
                        log.trace('add_to_pdir(%s): done', p);
                        cb();
                    }
                });
            });
        });
    });
};


// This is just for space-used tracking when fs extends a file.
Cache.prototype.extend = function extend(p, size) {
    assert.string(p, 'path');
    assert.number(size, 'size');

    this._grow_cache(p, size);
};


/**
 * When a caller knows that there is already somebody else performing
 * a download, rather than stomping all over each other, we just stack
 * up callers and wait for the data they need in the local cache file.
 *
 * This method performs that process of waiting for the data in
 * the local (dirty) cache file.
 *
 * `path` is the local cache file, not the manta path.
 * `pos` is the last byte of data to wait for.
 * `info` is an HTTP HEAD object
 */
Cache.prototype.wait = function wait(p, info, pos, cb) {
    assert.string(p, 'path');
    assert.object(info, 'info');
    assert.number(pos, 'position');
    assert.func(cb, 'callback');

    cb = once(cb);

    var log = this.log;
    var self = this;

    log.trace('wait(%s, %d, %d): entered', p, info.size, pos);

    // fs.watch() seems to be unreliable across platforms (like Mac),
    // so we do this the ghetto way :(
    (function poll() {
        self.dataInCache(p, pos, function onIsReady(err, ready) {
            if (err) {
                log.trace(err, 'wait(%s, %d, %d): failed', p, info.size, pos);
                cb(err);
            } else if (!ready) {
                setTimeout(poll, 10);
            } else {
                log.trace('wait(%s, %d, %d): ready', p, info.size, pos);
                cb();
            }
        });
    })();
};


//-- Open/Close/other stuff not mainline

Cache.prototype.open = function open() {
    var db_location = path.join(this.location, DB_NAME);
    var location = path.join(this.location, CACHE_DIR_NAME);
    var log = this.log;
    var self = this;

    log.debug('open: entered');

    var db_keys_done = false;
    var stale_check_cnt = 0;

    // When we come up, we need to check each of the cached objects to see if
    // the object is stale. If we have the local file cached then we keep
    // our local copy as long as the local file is not expired, otherwise we
    // just discard it. We don't try to check manta for each object since that
    // would make the server startup time unacceptably long when we have a lot
    // of cached objects.
    //
    // We assume that this function is never called for dirty objects.

    function check_object(now, key, p, c_info) {
        // keep track of how many files we're in the process of checking via
        // callback so we can know when to emit the 'ready' event
        stale_check_cnt++;

        if (!c_info.last_stat || (now - c_info.last_stat) > self.ttl_ms) {
            // consider it stale, cleanup locally cached file, if it exists
            fs.unlink(c_info._cacheFile, function (u_err) {
                // ignore errors deleting the cachefile, which may not exist
                log.trace('stale, discard: %s', p);
                stale_check_cnt--;
                if (db_keys_done && stale_check_cnt === 0)
                    self.emit('ready');
            });
        } else {
            // Our metadata is fresh, see if we have the object cached so we
            // can track its size.
            fs.stat(c_info._cacheFile, function (err, stats) {
                if (!err) {
                    // The file is still fresh, add to the current cache space
                    // used.
                    log.trace('not stale, keep: %s', p);
                    self._grow_cache(p, stats.size);
                }

                stale_check_cnt--;
                if (db_keys_done && stale_check_cnt === 0)
                    self.emit('ready');
            });
        }
    }

    utils.ensureAndStat(location, function onReady(err, stats) {
        if (err) {
            log.fatal(err, 'initialization of %s failed', location);
            self.emit('error', err);
            return;
        }

        if (stats.statvfs.availableMB < MB(self.max_size)) {
            log.warn('%s has %dMB available. Using as max size',
                     location, stats.statvfs.availableMB);

            self.max_size = bytes(stats.statvfs.availableMB);
        }

        self.db = levelup(db_location, {
            valueEncoding: 'json'
        });

        var enable_wb = false;
        var dcnt = 0;

        self.db.on('error', self.emit.bind(self, 'error'));
        self.db.once('ready', function onDatabase() {
            /* JSSTYLED */
            var d_re = /^:d:/;
            var keys = self.db.createReadStream();
            /* JSSTYLED */
            var f_re = /^:f:/;

            var now = Date.now();

            // We happen to know (since it's a BTree) that we're going to see
            // the keys for "dirty" before "files", so we can easily check for
            // dirty files when we're checking for stale files.
            var p;
            keys.on('data', function onDbEntry(data) {
                log.trace('open: DB entry: %j', data);
                if (d_re.test(data.key)) {
                    // add this cached file to the writeback work queue
                    p = data.key.substr(3);
                    enable_wb = true;
                    wb_pending[p] = data.value;
                    dcnt++;
                } else if (f_re.test(data.key)) {
                    p = data.key.substr(3);
                    var v = data.value;

                    // We always put the object into the LRU cache
                    self.cache.set(data.key, v);

                    if (wb_pending[p]) {
                        // The file is dirty, we're going to write it back,
                        // so always keep our info.
                        log.trace('open: dirty, keep: %s', p);
                        return;
                    }

                    check_object(now, data.key, p, v);
                }
            });

            keys.once('error', self.emit.bind(self, 'error'));

            keys.once('end', function () {
                log.debug('open: done');
                if (enable_wb) {
                    log.info('%d dirty files pending writeback', dcnt);
                    // process the backlog of writebacks
                    writeback_enabled = true;
                    setTimeout(_writeback.bind(self), 100);
                }
                db_keys_done = true;
                if (stale_check_cnt === 0)
                    self.emit('ready');
            });
        });
    });
};


Cache.prototype.close = function close(cb) {
    assert.optionalFunc(cb, 'callback');

    var log = this.log;
    var self = this;

    var _cb = once(function (err) {
        if (err) {
            log.error(err, 'close: failed');
            if (cb) {
                cb(err);
            } else {
                self.emit('error', err);
            }
        } else {
            log.debug(err, 'close: done');
            self.emit('close');
            if (cb)
                cb();
        }
    });

    log.debug('close: entered');

    if (this.db) {
        this.db.close(_cb);
    } else {
        _cb();
    }
};


Cache.prototype.toString = function toString() {
    var str = '[object ' +
        this.constructor.name + '<' +
        'location=' + this.location + ', ' +
        'max_size=' + this.max_size + ', ' +
        'ttl=' + this.ttl_ms / 1000 + ', ' +
        'wbtime=' + this.wbtime + ', ' +
        'num_par=' + this.num_par + ', ' +
        'current_size=' + this.current_size + '>]';

    return (str);
};
