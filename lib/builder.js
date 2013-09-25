/*
 * builder.js: Top-level include for module-smith.
 *
 * (C) 2012 Nodejitsu Inc.
 *
 */

var domain         = require('domain'),
    fs             = require('fs'),
    path           = require('path'),
    spawn          = require('child_process').spawn,
    util           = require('util'),
    zlib           = require('zlib'),
    EventEmitter   = require('events').EventEmitter,
    async          = require('async'),
    BufferedStream = require('buffered').BufferedStream,
    checkout       = require('checkout'),
    chownr         = require('chownr'),
    fstream        = require('fstream'),
    merge          = require('merge-recursive'),
    mkdirp         = require('mkdirp'),
    rimraf         = require('rimraf'),
    semver         = require('semver'),
    suspawn        = require('suspawn'),
    tar            = require('tar'),
    uidNumber      = require('uid-number'),
    Understudy     = require('understudy').Understudy;

//
// ### function readErrorLog (file, callback)
// #### @file     {string}   Full path to the error log to read.
// #### @callback {function} Continuation to respond to.
// Attempts to read the specified error log file, ignores errors
// in-case the file does not exist.
//
function readErrorLog(file, callback) {
  fs.readFile(file, 'utf8', function (err, text) {
    return text
      ? callback(null, text)
      : callback(null, null);
  });
}

//
// ### function ModuleSmith (options)
// #### @options {Object} Options for this instance.
// ####   @verions  {Array}  Set of node versions to build against.
// ####   @defaults {Object} Default options for this instance.
// Constructor function for the ModuleSmith object responsible for building
// npm packages using the specified `options`.
//
var ModuleSmith = exports.ModuleSmith = function ModuleSmith(options) {
  Understudy.call(this);
  EventEmitter.call(this);

  options = options || {};

  var runningVersion = process.version.slice(1),
      versions       = options.versions || [runningVersion],
      homedir        = process.env.platform === 'windows'
        ? process.env.HOMEPATH
        : process.env.HOME;

  this.versions = versions;
  this.defaults = merge.recursive({}, {
    env: {
      PATH: process.env.PATH
    },
    directories: {
      gyp:  path.join(homedir, '.node-gyp'),
      home: homedir
    },
    engines: {
      node: runningVersion
    },
    os: process.platform,
    uid: 'nobody'
  }, options.defaults || {});

  return this;
};

//
// Inherit from EventEmitter.
//
util.inherits(ModuleSmith, EventEmitter);

//
// ### function createModuleSmith (options)
// #### @options {Object} Options for the ModuleSmith instance.
// Creates a new ModuleSmith instance with the specified options.
//
exports.createModuleSmith = function (options) {
  return new ModuleSmith(options);
};

//
// ### function build (description, callback)
// #### @description {Object}   Description of the build to run.
// #### @callback    {function} Continuation to respond to.
// Executes a build run for the specified build `description`.
//
ModuleSmith.prototype.build = function build(description, callback) {
  var buildDomain = domain.createDomain(),
      finished = false,
      self = this;

  //
  // ### function done ()
  // Responds to the callback once.
  //
  function done() {
    if (!finished) {
      finished = true;
      return callback.apply(null, arguments);
    }
  }

  buildDomain.on('error', done);
  buildDomain.run(function () {
    async.waterfall([
      //
      // 1. Configure and spawn npm in a scaffolded directory structure
      //    for the build description.
      //
      self.perform.bind(self, 'build.configure', self.getBuildDescription(description)),
      self.scaffoldBuild.bind(self),
      self.downloadRepository.bind(self),
      self.prepareRepository.bind(self),
      self.perform.bind(self, 'npm.configure'),
      self.spawnNpm.bind(self),
      //
      // 2. Handle npm output.
      //
      function handleNpmOutput(description, builder, next) {
        builder.stdout.pipe(process.stdout);
        builder.stderr.pipe(process.stderr);
        self.emit('npm.spawned', description, builder);
        builder.on('exit', function (code) {
          return code !== 0
            ? next(new Error('npm exited with code ' + code))
            : next(null, description);
        });
      },
      //
      // 3. Check the error logs (builderror.log, npm-debug.log) to
      //    handle silent npm failures.
      //
      function checkErrorLogs(buildDescription, next) {
        var moduledir = buildDescription.directories.module;
        async.parallel({
          'builderror.log': async.apply(readErrorLog, path.join(moduledir, 'builderror.log')),
          'npm-debug.log':  async.apply(readErrorLog, path.join(moduledir, 'npm-debug.log'))
        }, function (_, logs) {
          //
          // Remark: There will never be an error because `readErrorLog`
          // supresses them.
          //
          var logStream = new BufferedStream(),
              nonEmpty,
              error;

          nonEmpty = Object.keys(logs).filter(function (file) {
            if (logs[file]) { logStream.write(logs[file]); }
            return !!logs[file];
          });

          if (nonEmpty.length) {
            error = new Error('Error output from ' + nonEmpty.join(', '));
            error.stream = logStream;
            error.code   = 400;
            logStream.end();
            return next(error);
          }

          next(null, buildDescription);
        });
      },
      //
      // 4. Remove `node_modules` when the `buildDescription.command` is
      //    "build". This handles the edge case where a binary module
      //    depends on **another** binary module.
      //
      function removeOnBuild(buildDescription, next) {
        if (buildDescription.command === 'build') {
          return rimraf(
            path.join(buildDescription.directories.module, 'node_modules'),
            function () { next(null, buildDescription) }
          );
        }

        next(null, buildDescription);
      },
      //
      // 5. Read and rewrite local files to handle
      //    edge cases in`bundledDependencies`.
      //
      function readLocalFiles(buildDescription, next) {
        var pkgFile = path.join(buildDescription.directories.module, 'package.json');
        async.waterfall([
          async.parallel.bind(async, {
            package: fs.readFile.bind(fs, pkgFile, 'utf8'),
            installedDependencies: function (next) {
              fs.readdir(path.join(buildDescription.directories.module, 'node_modules'), function (err, installedDependencies) {
                if (err) {
                  return err.code === 'ENOENT'
                   ? next(null, [])
                   : next(err, null);
                }

                next(null, installedDependencies.filter(function (dirname) {
                  return ['.bin'].indexOf(dirname) === -1;
                }));
              });
            }
          }),
          function (mappings, next) {
            var pkg = JSON.parse(mappings.package);
            pkg.os = buildDescription.os;
            if (buildDescription.command === 'install') {
              pkg.bundledDependencies = mappings.installedDependencies;
            }

            next(null, buildDescription, pkg);
          }
        ], next);
      },
      self.perform.bind(self, 'npm.package'),
      function rewritePackage(description, pkg, next) {
        var pkgFile = path.join(description.directories.module, 'package.json');
        fs.writeFile(pkgFile, JSON.stringify(pkg, null, 2) + '\n', function (err) {
          next(err, description);
        });
      }
    ], function (err, buildDescription) {
      if (err) {
        return done(err);
      }

      var stream = fstream.Reader({
        path: buildDescription.directories.module,
        isDirectory: true,
        type: 'Directory'
      })
      .on('error', done)
      .pipe(tar.Pack({ noProprietary: true }))
      .on('error', done)
      .pipe(zlib.Gzip())
      .on('error', done)
      .pipe(new BufferedStream());

      //
      // Remove the error listener on the buildDomain to avoid
      // mistakenly trapping errors in user code.
      //
      buildDomain.removeListener('error', done);
      self.perform('build.output', buildDescription, stream, done);
    });
  });
};

//
// ### function getPackageNodeVersion (pkg)
// #### @description {Object} Build description to get the node version from.
// Returns the node version for the specified `pkg` to build against.
//
ModuleSmith.prototype.getPackageNodeVersion = function (description) {
  var engines = description.engine || description.engines;
  return typeof engines !== 'string'
    ? semver.maxSatisfying(this.versions, engines && engines.node || this.defaults.engines.node)
    : semver.maxSatisfying(this.versions, engines);
};

//
// ### function getBuildDescription (description)
// #### @description {Object} Base build description to extend.
// Extends the build `description` with defaults.
//
ModuleSmith.prototype.getBuildDescription = function (description) {
  var rootdir = description.directories.root,
      builddir = path.join(rootdir, 'build'),
      buildDescription;

  buildDescription = merge.recursive({}, this.defaults, {
    os:       this.defaults.os,
    cpu:      this.defaults.cpu,
    filename: description.filename,
    command:  description.command || 'install',
    directories: {
      root:   rootdir,
      build:  builddir,
      module: path.join(builddir, 'package'),
      npm:    path.join(rootdir, 'npm-cache'),
      tmp:    path.join(rootdir, 'tmp')
    },
    options: description.options || [],
    uid:     description.uid === null ? this.defaults.uid : description.uid,
    gid:     description.gid === null ? this.defaults.gid : description.gid,
    env:     merge.recursive({
      HOME:   rootdir,
      ROOT:   rootdir,
      TMPDIR: path.join(rootdir, 'tmp'),
      npm_config_arch:           description.cpu,
      npm_config_production:     true,
      npm_config_cache:          path.join(rootdir, 'npm-cache'),
      npm_config_globalconfig:   path.join(rootdir, 'npmglobalrc'),
      npm_config_userconfig:     path.join(rootdir, 'npmlocalrc'),
      'npm_config_node-version': description.version || this.getPackageNodeVersion(description),
      npm_config_nodedir : this.defaults.directories.gyp
    }, description.env || {})
  });

  //
  // Streams can cuase recursion problems
  //
  buildDescription.repository = description.repository;
  buildDescription.env.USER = buildDescription.uid;
  buildDescription.env.npm_config_user = buildDescription.uid;
  return buildDescription;
};

//
// ### function scaffoldBuild (buildDescription, callback)
// #### @buildDescription {Object}   Build description to scaffold.
// #### @callback         {function} Continuation to respond to.
// Scaffolds the `buildDescription` by creating all the directories
// associated with it.
//
ModuleSmith.prototype.scaffoldBuild = function (buildDescription, callback) {
  async.parallel(
    Object.keys(buildDescription.directories).filter(function (directory) {
      return directory !== 'module';
    }).map(function (directory) {
      return mkdirp.bind(mkdirp, buildDescription.directories[directory]);
    }), function (err) {
      callback(err, buildDescription);
    }
  );
};

//
// ### function downloadRepository (buildDescription, callback)
// #### @buildDescription {Object}   Build description to download.
// #### @callback         {function} Continuation to respond to.
// Downloads the repository for the `buildDescription` from any
// of the valid sources:
//   * git
//   * tar
//   * npm
//
ModuleSmith.prototype.downloadRepository = function (buildDescription, callback) {
  buildDescription.repository.destination = buildDescription.directories.build;
  checkout(buildDescription.repository, function (err) {
    callback(err, buildDescription);
  });
};

//
// ### function prepareRepository (buildDescription, callback)
// #### @buildDescription {Object}   Build description to prepare.
// #### @callback         {function} Continuation to respond to.
// Prepares the specfied `buildDescription` by:
//   1. Getting the uid and gid
//   2. Reading the package.json
//   3. Getting the node version
//   4. Chown the directories for the uid and gid.
//
ModuleSmith.prototype.prepareRepository = function (buildDescription, callback) {
  var pkgFile = path.join(buildDescription.directories.module, 'package.json'),
      dir     = buildDescription.directories.root,
      self    = this;

  //
  // Helper function for updating the build description
  // with contents from the local `package.json`
  //
  function updatePackage(contents, next) {
    var pkg = JSON.parse(contents);
    buildDescription.version = semver.valid(buildDescription.version)
      ? buildDescription.version
      : self.getPackageNodeVersion(pkg);

    if (!buildDescription.version) {
      return next(new Error('No matching versions found'));
    }

    buildDescription.env.npm_config_nodedir = path.join(buildDescription.env.npm_config_nodedir, buildDescription.version);
    if (typeof pkg.env === 'object' && pkg.env && !Array.isArray(pkg.env)) {
      merge.recursive(buildDescription, { env: pkg.env });
    }

    next();
  }

  //
  // If there is no `process.setgid` then don't
  // bother using `uidNumber` and simply continue
  //
  if (!process.setgid) {
    delete buildDescription.gid;
    delete buildDescription.uid;
    return async.waterfall([
      fs.readFile.bind(fs, pkgFile),
      updatePackage,
    ], function (err) {
      callback(err, buildDescription);
    });
  }

  //
  // Default to `nobody` gid.
  //
  buildDescription.gid = buildDescription.gid !== null ? buildDescription.gid : 'nobody';
  uidNumber(buildDescription.uid, buildDescription.gid, function (err, uid, gid) {
    if (err) {
      return callback(err);
    }

    async.waterfall([
      fs.readFile.bind(fs, pkgFile),
      updatePackage,
      chownr.bind(chownr, dir, uid, gid)
    ], function (err) {
      callback(err, buildDescription);
    });
  });
};

//
// ### function spawnNpm (description, callback)
// #### @description {Object}   Build description to spawn npm for.
// #### @callback    {function} Continuation to respond to.
// Spawns npm for the specified `description`.
//
ModuleSmith.prototype.spawnNpm = function spawnNpm(description, callback) {
  var args = ['install'].concat(description.options || []),
      options,
      builder;

  options = {
    uid: description.uid,
    gid: description.gid,
    cwd: description.directories.module,
    env: description.env
  };

  //
  // Do not use `suspawn`, `gid`, or `uid` when on Windows.
  //
  if (process.platform === 'win32') {
    delete options.uid;
    delete options.gid;
    options.env.npm_config_user =
    options.env.USERNAME =
      process.env.USERNAME;

    options.env.APPDATA   = process.env.APPDATA;
    options.env.HOMEDRIVE = process.env.HOMEDRIVE;
    options.env.HOMEPATH  = process.env.HOMEPATH;

    var base = '/node/v0.8.25/x64/',
        cliScript = 'node_modules/npm/bin/npm-cli.js';

    args.unshift(base+cliScript);
    console.dir(options);
    console.dir(args);
    builder = spawn(base+'node.exe', args, options);
    return callback(null, description, builder);
  }

  builder = suspawn('npm', args, options);
  callback(null, description, builder);
};