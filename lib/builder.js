/*
 * index.js: Top-level include for module-smith.
 *
 * (C) 2012 Nodejitsu Inc.
 *
 */

var domain         = require('domain'),
    fs             = require('fs'),
    path           = require('path'),
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
    semver         = require('semver'),
    suspawn        = require('suspawn'),
    tar            = require('tar'),
    uidNumber      = require('uid-number'),
    Understudy     = require('understudy').Understudy;

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
      versions = options.versions || [runningVersion];

  this.versions = versions;
  this.defaults = merge.recursive({}, {
    env: {
      PATH: process.env.PATH
    },
    directories: {
      gyp: path.join(process.env.HOME, '.node-gyp')
    },
    package: {
      engines: {
        node: runningVersion
      }
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
  // ### function done (err, tgzStream)
  // Responds to the callback once.
  //
  function done(err, tgzStream) {
    if (!finished) {
      finished = true;
      return callback.apply(this, arguments);
    }
  }

  buildDomain.on('error', done);
  buildDomain.run(function () {
    async.waterfall([
      self.perform.bind(self, 'build.configure', self.getBuildDescription(description)),
      self.scaffoldBuild.bind(self),
      self.downloadRepository.bind(self),
      self.prepareRepository.bind(self),
      self.perform.bind(self, 'npm.configure'),
      self.spawnNpm.bind(self),
      function (description, builder, next) {
        builder.stdout.pipe(process.stdout);
        builder.stderr.pipe(process.stderr);
        self.emit('npm.spawned', description, builder);
        builder.on('exit', function (code) {
          return code !== 0
            ? next(new Error('npm exited with code ' + code))
            : next(null, description, builder);
        });
      },
      function (buildDescription, builder, next) {
        var pkgFile = path.join(buildDescription.directories.moduledir, 'package.json');
        async.waterfall([
          async.parallel.bind(async, {
            package: fs.readFile.bind(fs, pkgFile),
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
            var pkg = JSON.parse(mappings.package);
            pkg.os = buildDescription.os;
            pkg.bundledDependencies = mappings.installedDependencies;
            next(null, buildDescription, pkg);
          }
        ], next);
      },
      self.perform.bind(self, 'npm.package'),
      function (description, pkg, next) {
        var pkgFile = path.join(description.directories.moduledir, 'package.json');
        fs.writeFile(pkgFile, JSON.stringify(pkg, null, 2) + '\n', function (err) {
          next(err, description);
        });
      }
    ], function (err, buildDescription) {
      if (err) {
        return done(err);
      }

      var stream = fstream.Reader({
        path: buildDescription.directories.moduledir,
        isDirectory: true,
        type: 'Directory'
      })
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
// ### function getPackageNodeVersion (pkg)
// #### @pkg {Object} Package to get the node version from.
// Returns the node version for the specified `pkg` to build against.
//
ModuleSmith.prototype.getPackageNodeVersion = function (pkg) {
  var engines = pkg.engine || pkg.engines;
  return typeof engines !== 'string'
    ? semver.maxSatisfying(this.versions, engines && engines.node || this.defaults.package.engines.node)
    : semver.maxSatisfying(this.versions, engines);
};

//
// ### function getBuildDescription (description)
// #### @description {Object} Base build description to extend.
// Extends the build `description` with defaults.
//
ModuleSmith.prototype.getBuildDescription = function (description) {
  var rootdir = description.directories.rootdir,
      builddir = path.join(rootdir, 'build'),
      buildDescription;

  buildDescription = merge.recursive({}, this.defaults, {
    os:       this.defaults.os,
    cpu:      this.defaults.cpu,
    package:  description.package,
    filename: description.filename,
    directories: {
      rootdir:   rootdir,
      builddir:  builddir,
      moduledir: path.join(builddir, 'package'),
      npmdir:    path.join(rootdir, 'npm-cache'),
      tmpdir:    path.join(rootdir, 'tmp')
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
  var pkgFile = path.join(buildDescription.directories.moduledir, 'package.json'),
      dir     = buildDescription.directories.rootdir,
      self    = this;

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
      function (contents, next) {
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
ModuleSmith.prototype.spawnNpm = function spawnNpm(description, callback) {
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