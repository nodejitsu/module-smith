/*
 * index.js: Top-level include for module-smith.
 *
 * (C) 2012 Nodejitsu Inc.
 *
 */

var BufferedStream        = require('buffered').BufferedStream;
var EventEmitter          = require('events').EventEmitter;
var Understudy            = require('understudy').Understudy;
var async                 = require('async');
var checkout              = require('checkout');
var chownr                = require('chownr');
var domain                = require('domain');
var fs                    = require('fs');
var fstream               = require("fstream");
var merge                 = require('merge-recursive');
var mkdirp                = require('mkdirp');
var path                  = require('path');
var semver                = require('semver');
var suspawn               = require('suspawn');
var tar                   = require('tar');
var uidNumber             = require('uid-number');
var util                  = require('util');
var zlib                  = require('zlib');

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
  var runningVersion = process.version.slice(1);
  var versions = options.versions || [runningVersion];
  this.versions = versions;
  this.defaults = merge.recursive({}, {
    env: {
      PATH: process.env.PATH
    },
    directories: {
      gyp: process.env.HOME + '/.node-gyp/'
    },
    packageJSON: {
      engines: {
        node: runningVersion
      }
    },
    os: process.platform,
    uid: 'nobody'
  }, options.defaults || {});
  return this;
}

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
  var self = this;
  var finished = false;
  function done(err, tgzStream) {
    if (!finished) {
      finished = true;
      return callback.apply(this, arguments);
    }
  }
  var buildDomain = domain.createDomain();
  buildDomain.on('error', done);
  buildDomain.run(function () {
    async.waterfall([
      self.perform.bind(self, 'build.configure', self.getBuildDescription(description)),
      self.scaffoldBuild.bind(self),
      self.downloadRepository.bind(self),
      self.prepareRepository.bind(self),
      self.perform.bind(self, 'npm.configure'),
      self.spawnNPM.bind(self),
      function (description, builder, next) {
        builder.stdout.pipe(process.stdout);
        builder.stderr.pipe(process.stderr);
        self.emit('npm.spawned', description, builder);
        builder.on('exit', function (code) {
          if (code !== 0) {
            next(new Error('npm exited with code ' + code));
          }
          else {
            next(null, description, builder);
          }
        });
      },
      function (buildDescription, builder, next) {
        var pkgFile = path.join(buildDescription.directories.moduledir, 'package.json');
        async.waterfall([
          async.parallel.bind(async, {
            packageJSON: fs.readFile.bind(fs, pkgFile),
            installedDependencies: function (next) {
              fs.readdir(path.join(buildDescription.directories.moduledir, 'node_modules'), function (err, installedDependencies) {
                if (err) {
                  if (err.code === 'ENOENT') {
                    next(null, []);
                  }
                  else {
                    next(err, null);
                  }
                }
                else {
                  next(null, installedDependencies.filter(function (dirname) {
                    return ['.bin'].indexOf(dirname) === -1;
                  }));
                }
              });
            }
          }),
          function (mappings, next) {
            var pkgJSON = JSON.parse(mappings.packageJSON);
            pkgJSON.os = buildDescription.os;
            pkgJSON.bundledDependencies = mappings.installedDependencies;
            next(null, buildDescription, pkgJSON);
          }
        ], next);
      },
      self.perform.bind(self, 'npm.package'),
      function (description, packageJSON, next) {
        var pkgFile = path.join(description.directories.moduledir, 'package.json');
        fs.writeFile(pkgFile, JSON.stringify(packageJSON, null, 2) + '\n', function (err) {
          next(err, description);
        });
      }
    ], function (err, buildDescription) {
      if (err) {
        return done(err);
      }

      var stream = fstream.Reader({ path: buildDescription.directories.moduledir, type: "Directory", isDirectory: true })
        .on('error', done)
        .pipe(tar.Pack({ noProprietary: true }))
        .on('error', done)
        .pipe(zlib.Gzip())
        .on('error', done)
        .pipe(new BufferedStream());

      self.perform('build.output', buildDescription, stream, done);
    });
  });
};

//
// ### function getPackageNodeVersion (pkgJSON)
// #### @pkgJSON {Object} Package to get the node version from.
// Returns the node version for the specified `pkgJSON` to build against.
//
ModuleSmith.prototype.getPackageNodeVersion = function (pkgJSON) {
  var engines = pkgJSON.engine || pkgJSON.engines;
  if (typeof engines === 'string') {
    return semver.maxSatisfying(this.versions, engines);
  }
  else {
    return semver.maxSatisfying(this.versions, engines && engines.node || this.defaults.packageJSON.engines.node);
  }
};

//
// ### function getBuildDescription (description)
// #### @description {Object} Base build description to extend.
// Extends the build `description` with defaults.
//
ModuleSmith.prototype.getBuildDescription = function (description) {
  var rootdir = description.directories.rootdir;
  var builddir = rootdir + '/build';
  var buildDescription = merge.recursive({}, this.defaults, {
    os: this.defaults.os,
    cpu:  this.defaults.cpu,
    packageJSON: description.packageJSON,
    filename: description.filename,
    directories: {
      rootdir: rootdir,
      builddir: builddir,
      moduledir: builddir + '/package',
      npmdir: rootdir + '/npm-cache',
      tmpdir: rootdir + '/tmp'
    },
    options: description.options || [],
    uid: description.uid == null ? this.defaults.uid : description.uid,
    gid: description.gid == null ? this.defaults.gid : description.gid,
    env: merge.recursive({
      HOME : rootdir,
      ROOT : rootdir,
      TMPDIR : rootdir + '/tmp',
      npm_config_arch : description.cpu,
      npm_config_production : true,
      npm_config_cache : rootdir + '/npm-cache',
      npm_config_globalconfig : rootdir + '/npmglobalrc',
      npm_config_userconfig : rootdir + '/npmlocalrc',
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
      return directory !== 'moduledir';
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
  buildDescription.repository.destination = buildDescription.directories.builddir;
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
  var self = this;
  var dir = buildDescription.directories.rootdir;
  var pkg = path.join(buildDescription.directories.moduledir, 'package.json');
  uidNumber(buildDescription.uid, buildDescription.gid != null ? buildDescription.gid : 'nobody', function (err, uid, gid) {
    if (err) {
      callback(err);
      return;
    }
    async.waterfall([
      fs.readFile.bind(fs, pkg),
      function (contents, callback) {
        var pkgJSON = JSON.parse(contents);
        buildDescription.version = semver.valid(buildDescription.version) ? buildDescription.version : self.getPackageNodeVersion(pkgJSON);
        if (!buildDescription.version ) {
          callback(new Error('No matching versions found'));
          return;
        }
        buildDescription.env.npm_config_nodedir = path.join(buildDescription.env.npm_config_nodedir, buildDescription.version);
        if (typeof pkgJSON.env === 'object' && pkgJSON.env && !Array.isArray(pkgJSON.env)) {
          merge.recursive(buildDescription, {
            env: pkgJSON.env
          });
        }
        callback(null);
      },
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
ModuleSmith.prototype.spawnNPM = function spawnNPM(description, callback) {
  var builder = suspawn(
    'npm', [
    'install'
  ].concat(description.options), {
    uid: description.uid,
    gid: description.gid,
    cwd: description.directories.moduledir,
    env: description.env
  });
  callback(null, description, builder);
};