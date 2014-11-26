# Module Smith

![](https://i.cloudup.com/YjjosQY66o-3000x3000.png)

A simple extensible `npm` build bot that works on Linux, SmartOS, and Windows.

## Example

Given a small script for building a specific module:

``` js
var assert = require('assert'),
    tmp = require('tmp'),
    ModuleSmith = require('module-smith');

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
```

We can dump it to a file via:

```bash
node build.js > built.tgz
```

## API

### ModuleSmith.createModuleSmith(options)

* `Array` _options.versions_: List of the versions supported with absolute version numbers like ie. '0.8.12'
* `BuildDescription` _options.defaults_: The defaults for a build run using this ModuleSmith.

### ModuleSmith.build(buildDescription, callback(err, tgzStream))

Runs a build

### BuildDescription

``` js
{
  uid: 'nobody',
  gid: 'nobody',
  command: 'install',
  env: {
    'npm_config_registry': 'http://registry.npmjs.org',
    'npm_config_nodedir':  path.join(process.env.HOME, '.node-gyp')
  },
  repository: {
    type: 'git',
    url: 'git@github.com:bmeck/bcrypt-example.git'
  },
  directories: {
    root: '/path/to/build/output/root'
  }
}
```

A build description enumerates a number of values

#### BuildDescription.command

The `npm` command that you wish to execute for the build. Can be:

* `install`: Installs all module dependencies.
* `build`: Runs `node-gyp` to build any binary dependencies.

#### BuildDescription.env

Optional environmental variables to spawn `npm` with.

Some interesting fields are:

* npm_config_registry - registry to download from
* npm_config_nodedir - location of node-gyp's include directory

#### BuildDescription.uid = 'nobody'

Optional user to spawn `npm` as.

#### BuildDescription.gid = undefined

Optional group to spawn `npm` under.

#### BuildDescription.package

Optional package.json overrides.
Can be extended easily from the repository during `npm.configure`.

Some interesting fields are:

* engines.node - version to spawn as

#### BuildDescription.repository

A `checkout` npm module repository to download before building.

#### BuildDescription.directories.root

The place to use for creating the build.

## Understudy Actions

Extensibility for complex actions can be done via Understudy based actions, only `before` actions are supported.

* build.configure (buildDescription)
* npm.configure (buildDescription)
* npm.package (buildDescription, package)
* build.output (buildDescription, tgzStream)

## Events

Notifications of actions that have been completed are available via the EventEmitter APIs.

* npm.spawned (buildDescription, npmProcess)

<hr>
#### Copyright (C) Charlie Robbins, Bradley Meck and the Contributors
#### Authors: [Bradley Meck](https://github.com/bmeck), [Charlie Robbins](https://github.com/indexzero)
#### License: MIT

_Hammer Icon by Edward Boatman from The Noun Project_
