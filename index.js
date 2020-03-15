'use strict';

const BbPromise = require('bluebird');
const s3 = require('@auth0/s3');
const chalk = require('chalk');
const minimatch = require('minimatch');
const path = require('path');
const fs = require('fs');
const resolveStackOutput = require('./resolveStackOutput')
const messagePrefix = 'S3 Sync: ';
const mime = require('mime');

const toS3Path = (osPath) => osPath.replace(new RegExp(`\\${path.sep}`, 'g'), '/');

class ServerlessS3Sync {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options || {};
    this.servicePath = this.serverless.service.serverless.config.servicePath;

    this.commands = {
      s3sync: {
        usage: 'Sync directories and S3 prefixes',
        lifecycleEvents: [
          'sync',
          'metadata'
        ],
        commands: {
          bucket: {
            options: {
              bucket: {
                usage: 'Specify the bucket you want to deploy (e.g. "-b myBucket1")',
                required: true,
                shortcut: 'b'
              }
            },
            lifecycleEvents: [
              'sync',
              'metadata'
            ]
          }
        }
      }
    };

    this.hooks = {
      'after:deploy:deploy': () => options.nos3sync ? undefined : BbPromise.bind(this).then(this.sync).then(this.syncMetadata),
      'before:remove:remove': () => BbPromise.bind(this).then(this.clear),
      's3sync:sync': () => BbPromise.bind(this).then(this.sync),
      's3sync:metadata': () => BbPromise.bind(this).then(this.syncMetadata),
      's3sync:bucket:sync': () => BbPromise.bind(this).then(this.sync),
      's3sync:bucket:metadata': () => BbPromise.bind(this).then(this.syncMetadata)
    };
  }

  client() {
    const provider = this.serverless.getProvider('aws');
	let awsCredentials, region;
	if (provider.cachedCredentials && typeof(provider.cachedCredentials.accessKeyId) != 'undefined'
		&& typeof(provider.cachedCredentials.secretAccessKey) != 'undefined'
		&& typeof(provider.cachedCredentials.sessionToken) != 'undefined') {
		region = provider.cachedCredentials.region
		awsCredentials = {
			accessKeyId: provider.cachedCredentials.accessKeyId,
			secretAccessKey: provider.cachedCredentials.secretAccessKey,
			sessionToken: provider.cachedCredentials.sessionToken,
		}
	} else {
		region = provider.getCredentials().region
		awsCredentials = provider.getCredentials().credentials
	}
    const s3Client = new provider.sdk.S3({
      region: region,
      credentials: awsCredentials
    });
    return s3.createClient({ s3Client });
  }

  sync() {
    const s3Sync = this.serverless.service.custom.s3Sync;
    const cli = this.serverless.cli;
    if (!Array.isArray(s3Sync)) {
      cli.consoleLog(`${messagePrefix}${chalk.red('No configuration found')}`)
      return Promise.resolve();
    }
    if (this.options.bucket) {
      cli.consoleLog(`${messagePrefix}${chalk.yellow(`Syncing directory attached to S3 bucket ${this.options.bucket}...`)}`);
    } else {
      cli.consoleLog(`${messagePrefix}${chalk.yellow('Syncing directories and S3 prefixes...')}`);
    }
    const servicePath = this.servicePath;
    const promises = s3Sync.map((s) => {
      let bucketPrefix = '';
      if (s.hasOwnProperty('bucketPrefix')) {
        bucketPrefix = s.bucketPrefix;
      }
      let acl = 'private';
      if (s.hasOwnProperty('acl')) {
        acl = s.acl;
      }
      let followSymlinks = false;
      if (s.hasOwnProperty('followSymlinks')) {
        followSymlinks = s.followSymlinks;
      }
      let defaultContentType = undefined
      if (s.hasOwnProperty('defaultContentType')) {
        defaultContentType = s.defaultContentType;
      }
      if ((!s.bucketName && !s.bucketNameKey) || !s.localDir) {
        throw 'Invalid custom.s3Sync';
      }
      let deleteRemoved = true;
      if (s.hasOwnProperty('deleteRemoved')) {
          deleteRemoved = s.deleteRemoved;
      }

      return this.getBucketName(s)
        .then(bucketName => {
          if (this.options.bucket && bucketName != this.options.bucket) {
            // if the bucket option is given, that means we're in the subcommand where we're
            // only syncing one bucket, so only continue if this bucket name matches
            return null;
          }
          return new Promise((resolve) => {
            const localDir = [servicePath, s.localDir].join('/');

            const params = {
              maxAsyncS3: 5,
              localDir,
              deleteRemoved,
              followSymlinks: followSymlinks,
              getS3Params: (localFile, stat, cb) => {
                const s3Params = {};

                if(Array.isArray(s.params)) {
                  s.params.forEach((param) => {
                    const glob = Object.keys(param)[0];
                    if(minimatch(localFile, `${path.resolve(localDir)}/${glob}`)) {
                      Object.assign(s3Params, this.extractMetaParams(param) || {});
                    }
                  });
                }

                cb(null, s3Params);
              },
              s3Params: {
                Bucket: bucketName,
                Prefix: bucketPrefix,
                ACL: acl
              }
            };
            if (typeof(defaultContentType) != 'undefined') {
              Object.assign(params, {defaultContentType: defaultContentType})
            }
            const uploader = this.client().uploadDir(params);
            uploader.on('error', (err) => {
              throw err;
            });
            let percent = 0;
            uploader.on('progress', () => {
              if (uploader.progressTotal === 0) {
                return;
              }
              const current = Math.round((uploader.progressAmount / uploader.progressTotal) * 10) * 10;
              if (current > percent) {
                percent = current;
                cli.printDot();
              }
            });
            uploader.on('end', () => {
              resolve('done');
            });
          });
        });
    });
    return Promise.all(promises)
      .then(() => {
        cli.printDot();
        cli.consoleLog('');
        cli.consoleLog(`${messagePrefix}${chalk.yellow('Synced.')}`);
      });
  }

  clear() {
    const s3Sync = this.serverless.service.custom.s3Sync;
    if (!Array.isArray(s3Sync)) {
      return Promise.resolve();
    }
    const cli = this.serverless.cli;
    cli.consoleLog(`${messagePrefix}${chalk.yellow('Removing S3 objects...')}`);
    const promises = s3Sync.map((s) => {
      let bucketPrefix = '';
      if (s.hasOwnProperty('bucketPrefix')) {
        bucketPrefix = s.bucketPrefix;
      }
      return this.getBucketName(s)
        .then(bucketName => {
          return new Promise((resolve) => {
            const params = {
              Bucket: bucketName,
              Prefix: bucketPrefix
            };
            const uploader = this.client().deleteDir(params);
            uploader.on('error', (err) => {
              throw err;
            });
            let percent = 0;
            uploader.on('progress', () => {
              if (uploader.progressTotal === 0) {
                return;
              }
              const current = Math.round((uploader.progressAmount / uploader.progressTotal) * 10) * 10;
              if (current > percent) {
                percent = current;
                cli.printDot();
              }
            });
            uploader.on('end', () => {
              resolve('done');
            });
          });
        });
    });
    return Promise.all(promises)
      .then(() => {
        cli.printDot();
        cli.consoleLog('');
        cli.consoleLog(`${messagePrefix}${chalk.yellow('Removed.')}`);
      });
  }

  syncMetadata() {
    const s3Sync = this.serverless.service.custom.s3Sync;
    const cli = this.serverless.cli;
    if (!Array.isArray(s3Sync)) {
      cli.consoleLog(`${messagePrefix}${chalk.red('No configuration found')}`)
      return Promise.resolve();
    }
    cli.consoleLog(`${messagePrefix}${chalk.yellow('Syncing metadata...')}`);
    const servicePath = this.servicePath;
    const promises = s3Sync.map( async (s) => {
      let bucketPrefix = '';
      if (s.hasOwnProperty('bucketPrefix') && s.bucketPrefix.length > 0) {
        bucketPrefix = s.bucketPrefix.replace(/\/?$/, '').replace(/^\/?/, '/')
      }
      let acl = 'private';
      if (s.hasOwnProperty('acl')) {
        acl = s.acl;
      }
      if ((!s.bucketName && !s.bucketNameKey) || !s.localDir) {
        throw 'Invalid custom.s3Sync';
      }
      const localDir = path.join(servicePath, s.localDir);
      let filesToSync = [];
      if(Array.isArray(s.params)) {
        s.params.forEach((param) => {
          const glob = Object.keys(param)[0];
          let files = this.getLocalFiles(localDir, []);
          minimatch.match(files, `${path.resolve(localDir)}${path.sep}${glob}`, {matchBase: true}).forEach((match) => {
            filesToSync.push({name: match, params: this.extractMetaParams(param)});
          });
        });
      }
      return this.getBucketName(s)
        .then(bucketName => {
          if (this.options && this.options.bucket && bucketName != this.options.bucket) {
            // if the bucket option is given, that means we're in the subcommand where we're
            // only syncing one bucket, so only continue if this bucket name matches
            return null;
          }

          return Promise.all(filesToSync.map((file) => {
            return new Promise((resolve) => {
              let contentTypeObject = {};
              let detectedContentType = mime.getType(file.name)
              if (detectedContentType !== null || s.hasOwnProperty('defaultContentType')) {
                contentTypeObject.ContentType = detectedContentType ? detectedContentType : s.defaultContentType;
              }
              let params = {
                ...contentTypeObject,
                ...file.params,
                ...{
                  CopySource: toS3Path(file.name.replace(path.resolve(localDir) + path.sep, `${bucketName}${bucketPrefix == '' ? '' : bucketPrefix}/`)),
                  Key: toS3Path(file.name.replace(path.resolve(localDir) + path.sep, '')),
                  Bucket: bucketName,
                  ACL: acl,
                  MetadataDirective: 'REPLACE'
                }
              };
              const uploader = this.client().copyObject(params);
              uploader.on('error', (err) => {
                throw err;
              });
              uploader.on('end', () => {
                resolve('done');
              });
            });
          }));
        });
    });
    return Promise.all((promises))
      .then(() => {
        cli.printDot();
        cli.consoleLog('');
        cli.consoleLog(`${messagePrefix}${chalk.yellow('Synced metadata.')}`);
      });
  }

  getLocalFiles(dir, files) {
    fs.readdirSync(dir).forEach(file => {
      let fullPath = path.join(dir, file);
      if (fs.lstatSync(fullPath).isDirectory()) {
        this.getLocalFiles(fullPath, files);
      } else {
        files.push(fullPath);
      }
    });
    return files;
  }

  extractMetaParams(config) {
    const validParams = {};
    const keys = Object.keys(config);
    for (let i = 0; i < keys.length; i++) {
      Object.assign(validParams, config[keys[i]])
    }
    return validParams;
  }

  getBucketName(s) {
    if (s.bucketName) {
      return Promise.resolve(s.bucketName)
    } else if (s.bucketNameKey) {
      return resolveStackOutput(this, s.bucketNameKey)
    } else {
      return Promise.reject("Unable to find bucketName. Please provide a value for bucketName or bucketNameKey")
    }
  }
}

module.exports = ServerlessS3Sync;
