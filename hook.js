const Codec = require('level-codec')

module.exports = function (db, callback) {
  var codec = new Codec(db.options)

  function onput (key, value, options) {
    callback({
      key: codec.encodeKey(key, options),
      value: codec.encodeValue(value, options)
    })
  }

  function onbatch (ops, options) {
    codec.encodeBatch(ops, options).forEach(callback)
  }

  db.on('put', onput)
  db.on('batch', onbatch)

  return function () {
    db.removeListener('put', onput)
    db.removeListener('batch', onbatch)
  }
}
