/*
 * bcrypt.js: Example that builds bcrypt.
 *
 * (C) 2012 Nodejitsu Inc.
 *
 */

var assert = require('assert'),
    tmp = require('tmp'),
    moduleSmith = require('../');

var buildbot = moduleSmith.createModuleSmith();

//
// Grab a temporary directory to build in
//
tmp.dir(function (err, tmpdir) {
  assert.ifError(err);
  //
  // Start our build
  //
  buildbot.build({
    repository: {
      type: 'git',
      url: 'git@github.com:bmeck/bcrypt-example.git'
    },
    directories: {
      root: tmpdir
    }
  }, function (err, stream) {
    assert.ifError(err);
    //
    // Pipe out the data to stdio
    //
    stream.pipe(process.stdout);
  });
});
