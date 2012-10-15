var tmp = require('tmp');
var assert = require('assert');

var ModuleSmith = require('../');
var buildbot = ModuleSmith.createModuleSmith();

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
         rootdir: tmpdir
      }
   }, function (err, stream) {
      assert.ifError(err);
      //
      // Pipe out the data to stdio
      //
      stream.pipe(process.stdout);
   });
});
