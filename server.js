var lpstream = require('length-prefixed-stream')
var eos = require('end-of-stream')
var duplexify = require('duplexify')
var ltgt = require('ltgt')
var messages = require('./messages')
var hook = require('./hook')

var DECODERS = [
  messages.Get,
  messages.Put,
  messages.Delete,
  messages.Batch,
  messages.Iterator
]

module.exports = function (db, opts) {
  if (!opts) opts = {}

  var readonly = !!(opts.readonly)
  var enableLive = (opts.live !== false)
  var decode = lpstream.decode()
  var encode = lpstream.encode()
  var stream = duplexify(decode, encode)

  var preput = opts.preput || function (key, val, cb) { cb(null) }
  var predel = opts.predel || function (key, cb) { cb(null) }
  var prebatch = opts.prebatch || function (ops, cb) { cb(null) }

  if (db.isOpen()) ready()
  else db.open(ready)

  return stream

  function ready () {
    var down = db.db
    var iterators = []
    var cleanupHook = enableLive && hook(db, pushtoiterators)

    eos(stream, function () {
      if (cleanupHook) cleanupHook()
      while (iterators.length) {
        var next = iterators.shift()
        if (next) next.end()
      }
    })

    decode.on('data', function (data) {
      if (!data.length) return
      var tag = data[0]
      if (tag >= DECODERS.length) return

      var dec = DECODERS[tag]
      try {
        var req = dec.decode(data, 1)
      } catch (err) {
        return
      }

      if (readonly) {
        switch (tag) {
          case 0: return onget(req)
          case 1: return onreadonly(req)
          case 2: return onreadonly(req)
          case 3: return onreadonly(req)
          case 4: return oniterator(req)
        }
      } else {
        switch (tag) {
          case 0: return onget(req)
          case 1: return onput(req)
          case 2: return ondel(req)
          case 3: return onbatch(req)
          case 4: return oniterator(req)
        }
      }
    })

    function callback (id, err, value) {
      var msg = {id: id, error: err && err.message, value: value}
      var buf = new Buffer(messages.Callback.encodingLength(msg) + 1)
      buf[0] = 0
      messages.Callback.encode(msg, buf, 1)
      encode.write(buf)
    }

    function iteratordata (data) {
      var buf = new Buffer(messages.IteratorData.encodingLength(data) + 1)
      buf[0] = 1
      messages.IteratorData.encode(data, buf, 1)
      encode.write(buf)
    }

    function onput (req) {
      preput(req.key, req.value, function (err) {
        if (err) return callback(err)
        down.put(req.key, req.value, function (err) {
          if (!err && enableLive) {
            pushtoiterators({key: req.key, value: req.value})
          }
          callback(req.id, err, null)
        })
      })
    }

    function onget (req) {
      down.get(req.key, function (err, value) {
        callback(req.id, err, value)
      })
    }

    function ondel (req) {
      predel(req.key, function (err) {
        if (err) return callback(err)
        down.del(req.key, function (err) {
          callback(req.id, err)
        })
      })
    }

    function onreadonly (req) {
      callback(req.id, new Error('Database is readonly'))
    }

    function onbatch (req) {
      prebatch(req.ops, function (err) {
        if (err) return callback(err)
        down.batch(req.ops, function (err) {
          if (!err && enableLive) {
            req.ops.forEach(pushtoiterators)
          }
          callback(req.id, err)
        })
      })
    }

    function oniterator (req) {
      if (req.options && req.options.live && !enableLive) {
        return iteratordata({
          id: req.id,
          err: new Error('Database does not support live read streams')
        })
      }

      while (iterators.length < req.id) iterators.push(null)

      var prev = iterators[req.id]
      if (!prev) prev = iterators[req.id] = new Iterator(down, req, iteratordata)

      if (!req.batch) {
        iterators[req.id] = null
        prev.end()
      } else {
        prev.batch = req.batch
        prev.next()
      }
    }

    function pushtoiterators (op) {
      if (op.type && op.type !== 'put') return
      for (var i = 0; i < iterators.length; i += 1) {
        if (iterators[i] && iterators[i].push) {
          iterators[i].push(op)
        }
      }
    }
  }
}

function Iterator (down, req, respond) {
  var self = this

  this.batch = req.batch || 0

  if (req.options) {
    if (req.options.gt === null) req.options.gt = undefined
    if (req.options.gte === null) req.options.gte = undefined
    if (req.options.lt === null) req.options.lt = undefined
    if (req.options.lte === null) req.options.lte = undefined
  }

  this._iterator = down.iterator(req.options)
  this._send = send
  this._nexting = false
  this._first = true
  this._ended = false
  this._data = {
    id: req.id,
    error: null,
    key: null,
    value: null
  }

  if (req.options && req.options.live) {
    this._buffer = []
    this.push = function (op) {
      if (self._buffer.length < 32 && ltgt.contains(req.options, op.key)) {
        self._buffer.push(op)
        self.next()
      }
    }
  }

  function send (err, key, value) {
    self._nexting = false
    if (!err && !key && !value && self._buffer) {
      var op = self._buffer.shift()
      if (!op) return
      key = op.key
      value = op.value
    }
    self._data.error = err && err.message
    self._data.key = key
    self._data.value = value
    self.batch--
    respond(self._data)
    self.next()
  }
}

Iterator.prototype.next = function () {
  if (this._nexting || this._ended) return
  if (!this._first) {
    if (!this.batch || this._data.error) return
    if (!this._data.key && !this._data.value && !this._buffer) return
  }
  this._first = false
  this._nexting = true
  this._iterator.next(this._send)
}

Iterator.prototype.end = function () {
  this._ended = true
  this._iterator.end(noop)
}

function noop () {}
