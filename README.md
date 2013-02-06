# Module Smith

A simple extensible NPM build bot.

## Example

Given a small script for building a specific module:

```javascript
var tmp = require('tmp');
var assert = require('assert');

var ModuleSmith = require('module-smith');
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
```

We can dump it to a file via:

```bash
node build.js > built.tgz
```

## API

### ModuleSmith.createModuleSmith(options)

#### String[] options.versions

List of the versions supported with absolute version numbers like ie. '0.8.12'

#### BuildDescription options.defaults

The defaults for a build run using this ModuleSmith.

### ModuleSmith.build(buildDescription, callback(err, tgzStream))

Runs a build

### BuildDescription

A build description enumerates a number of values

#### BuildDescription.env

Optional environmental variables to spawn `npm` with.

Some interesting fields are:

* npm_config_registry - registry to download from
* npm_config_nodedir - location of node-gyp's include directory

#### BuildDescription.uid = 'nobody'

Optional user to spawn `npm` as.

#### BuildDescription.gid = undefined

Optional group to spawn `npm` under.

#### BuildDescription.packageJSON

Optional package.json overrides.
Can be extended easily from the repository during `npm.configure`.

Some interesting fields are:

* engines.node - version to spawn as


#### BuildDescription.repository

A `checkout` npm module repository to download wbefore building.

#### BuildDescription.directories.rootdir

The place to use for creating the build.

## Understudy Actions

Extensibility for complex actions can be done via Understudy based actions, only `before` actions are supported.

### build.configure (buildDescription)

### npm.configure (buildDescription)

### npm.package (buildDescription, packageJSON)

## Events

Notifications of actions that have been completed are available via the EventEmitter APIs.

### npm.spawned (buildDescription, npmProcess)

### build.output (buildDescription, tgzStream)
