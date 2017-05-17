var tape = require('tape')
var memdown = require('memdown')
var levelup = require('levelup')
var multileveldown = require('../')

tape('read live stream', function (t) {
  var db = levelup('no-location', {db: mem})
  var stream = multileveldown.server(db)
  var client = multileveldown.client()

  stream.pipe(client.createRpcStream()).pipe(stream)

  var rs = client.createReadStream({live: true})

  // Wait for read stream to complete it's first round trip to ensure live put
  setTimeout(function () {
    db.put('hello', 'world', function (err) {
      t.error(err, 'no err')
    })
  }, 10)

  rs.on('data', function (data) {
    t.same(data, {key: 'hello', value: 'world'})
    t.end()
  })
})

tape('read live stream (client put)', function (t) {
  var db = levelup('no-location', {db: mem})
  var stream = multileveldown.server(db)
  var client = multileveldown.client()

  stream.pipe(client.createRpcStream()).pipe(stream)

  var rs = client.createReadStream({live: true})

  // Wait for read stream to complete it's first round trip to ensure live put
  setTimeout(function () {
    client.put('hello', 'world', function (err) {
      t.error(err, 'no err')
    })
  }, 10)

  rs.on('data', function (data) {
    t.same(data, {key: 'hello', value: 'world'})
    t.end()
  })
})

tape('read live stream (gt)', function (t) {
  var db = levelup('no-location', {db: mem})
  var stream = multileveldown.server(db)
  var client = multileveldown.client()

  stream.pipe(client.createRpcStream()).pipe(stream)

  var rs = client.createReadStream({gt: 'hej', live: true})

  // Wait for read stream to complete it's first round trip to ensure live puts
  setTimeout(function () {
    db.batch([
      {type: 'put', key: 'hej', value: 'verden'},
      {type: 'put', key: 'hello', value: 'world'}
    ], function (err) {
      t.error(err, 'no err')
    })
  }, 10)

  rs.on('data', function (data) {
    t.same(data, {key: 'hello', value: 'world'})
    t.end()
  })
})

function mem () {
  return memdown()
}
