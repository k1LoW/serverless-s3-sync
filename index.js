'use strict';

const BbPromise = require('bluebird');
const s3 = require('@auth0/s3');
const minimatch = require('minimatch');
const path = require('path');
const fs = require('fs');
const resolveStackOutput = require('./resolveStackOutput')
const getAwsOptions = require('./getAwsOptions')
const mime = require('mime');
const child_process = require('child_process');

const toS3Path = (osPath) => osPath.replace(new RegExp(`\\${path.sep}`, 'g'), '/');

class ServerlessS3Sync {
  constructor(serverless, options, logging) {
    this.serverless = serverless;
    this.options = options || {};
    this.log = logging.log;
    this.progress = logging.progress;
    this.servicePath = this.serverless.service.serverless.config.servicePath;

    this.commands = {
      s3sync: {
        usage: 'Sync directories and S3 prefixes',
        lifecycleEvents: [
          'sync',
          'metadata',
          'tags'
        ],
        commands: {
          bucket: {
            options: {
              bucket: {
                usage: 'Specify the bucket you want to deploy (e.g. "-b myBucket1")',
                required: true,
                shortcut: 'b',
                type: 'string'
              }
            },
            lifecycleEvents: [
              'sync',
              'metadata',
              'tags'
            ]
          }
        }
      },
      deploy: {
        options: {
          nos3sync: {
            type: 'boolean',
            usage: 'Disable sync to S3 during deploy'
          }
        }
      },
      remove: {
        options: {
          nos3sync: {
            type: 'boolean',
            usage: 'Disable sync to S3 during remove'
          }
        }
      }
    };

    const noSync = this.getNoSync();

    this.hooks = {
      'after:deploy:deploy': () => noSync ? undefined : BbPromise.bind(this).then(this.sync).then(this.syncMetadata).then(this.syncBucketTags),
      'after:offline:start:init': () => noSync ? undefined : BbPromise.bind(this).then(this.sync).then(this.syncMetadata).then(this.syncBucketTags),
      'after:offline:start': () => noSync ? undefined : BbPromise.bind(this).then(this.sync).then(this.syncMetadata).then(this.syncBucketTags),
      'before:remove:remove': () => noSync ? undefined : BbPromise.bind(this).then(this.clear),
      's3sync:sync': () => BbPromise.bind(this).then(() => this.sync(true)),
      's3sync:metadata': () => BbPromise.bind(this).then(() => this.syncMetadata(true)),
      's3sync:tags': () => BbPromise.bind(this).then(() => this.syncBucketTags(true)),
      's3sync:bucket:sync': () => BbPromise.bind(this).then(() => this.sync(true)),
      's3sync:bucket:metadata': () => BbPromise.bind(this).then(() => this.syncMetadata(true)),
      's3sync:bucket:tags': () => BbPromise.bind(this).then(() => this.syncBucketTags(true)),
    };
  }

  isOffline() {
    return String(this.options.offline).toUpperCase() === 'TRUE' || process.env.IS_OFFLINE;
  }

  getEndpoint() {
      return this.serverless.service.custom.s3Sync.hasOwnProperty('endpoint') ? this.serverless.service.custom.s3Sync.endpoint : null;
  }

  getNoSync() {
    if (this.options.nos3sync) {
      return true;
    }
    const noSync = this.serverless.service.custom.s3Sync.hasOwnProperty('noSync') ? this.serverless.service.custom.s3Sync.noSync : false;
    return String(noSync).toUpperCase() === 'TRUE';
  }

  client() {
    const provider = this.serverless.getProvider('aws');
    const s3Options = getAwsOptions(provider)

    if(this.getEndpoint() && this.isOffline()) {
      s3Options.endpoint = new provider.sdk.Endpoint(this.serverless.service.custom.s3Sync.endpoint);
      s3Options.s3ForcePathStyle = true;
    }
    const s3Client = new provider.sdk.S3(s3Options);
    if(this.getEndpoint() && this.isOffline()) {
      //see: https://github.com/aws/aws-sdk-js/issues/1157
      s3Client.shouldDisableBodySigning = () => true
    }
    return s3.createClient({ s3Client });
  }

  sync(invokedAsCommand) {
    let s3Sync = this.serverless.service.custom.s3Sync;
    if(s3Sync.hasOwnProperty('buckets')) {
      s3Sync = s3Sync.buckets;
    }
    if (!Array.isArray(s3Sync)) {
      this.log.error('serverless-s3-sync requires at least one configuration entry in custom.s3Sync')
      return Promise.resolve();
    }

    const taskProgress = this.progress.create({
      message: this.options.bucket?
        `Syncing directory attached to S3 bucket ${this.options.bucket}` :
        'Syncing directories to S3 buckets'
    })

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
      if (s.hasOwnProperty('enabled') && s.enabled === false) {
        return;
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
      let preCommand = undefined
      if (s.hasOwnProperty('preCommand')) {
          preCommand = s.preCommand;
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

            // we're doing the upload in parallel for all buckets, so create one progress entry for each
            let percent = 0;
            const getProgressMessage = () => `${localDir}: sync with bucket ${bucketName} (${percent}%)`;
            const bucketProgress = this.progress.create({ message: getProgressMessage() })

            if (typeof(preCommand) != 'undefined') {
              bucketProgress.update(`${localDir}: running pre-command...`);
              child_process.execSync(preCommand, { stdio: 'inherit' });
            }

            const params = {
              maxAsyncS3: 5,
              localDir,
              deleteRemoved,
              followSymlinks: followSymlinks,
              getS3Params: (localFile, stat, cb) => {
                const s3Params = {};
                let onlyForEnv;

                if(Array.isArray(s.params)) {
                  s.params.forEach((param) => {
                    const glob = Object.keys(param)[0];
                    if(minimatch(localFile, `${path.resolve(localDir)}/${glob}`)) {
                      Object.assign(s3Params, this.extractMetaParams(param) || {});
                      onlyForEnv = s3Params['OnlyForEnv'] || onlyForEnv;
                    }
                  });
                  // to avoid parameter validation error
                  delete s3Params['OnlyForEnv'];
                }

                if (onlyForEnv && onlyForEnv !== this.options.env) {
                  cb(null, null);
                } else {
                  cb(null, s3Params);
                }
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

            bucketProgress.update(getProgressMessage());

            const uploader = this.client().uploadDir(params);
            uploader.on('error', (err) => {
              bucketProgress.remove();
              throw err;
            });
            uploader.on('progress', () => {
              if (uploader.progressTotal === 0) {
                return;
              }
              const current = Math.round((uploader.progressAmount / uploader.progressTotal) * 10) * 10;
              if (current > percent) {
                percent = current;
                bucketProgress.update(getProgressMessage());
              }
            });
            uploader.on('end', () => {
              bucketProgress.remove();
              resolve('done');
            });
          });
        });
    });
    return Promise.all(promises)
      .then(() => {
        if (invokedAsCommand) {
          this.log.success('Synced files to S3 buckets');
        } else {
          this.log.verbose('Synced files to S3 buckets');
        }
      })
      .finally(() => {
        taskProgress.remove();
      });
  }

  clear() {
    let s3Sync = this.serverless.service.custom.s3Sync;
    if(s3Sync.hasOwnProperty('buckets')) {
      s3Sync = s3Sync.buckets;
    }
    if (!Array.isArray(s3Sync)) {
      this.log.notice(`No configuration found for serverless-s3-sync, skipping removal...`);
      return Promise.resolve();
    }

    const taskProgress = this.progress.create({ message: 'Removing objects from S3 buckets' });

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

            let percent = 0;
            let getProgressMessage = () => `${bucketName}: removing files with prefix ${bucketPrefix} (${percent}%)`
            const bucketProgress = this.progress.create({ message: getProgressMessage() })

            const uploader = this.client().deleteDir(params);
            uploader.on('error', (err) => {
              bucketProgress.remove();
              throw err;
            });
            uploader.on('progress', () => {
              if (uploader.progressTotal === 0) {
                return;
              }
              const current = Math.round((uploader.progressAmount / uploader.progressTotal) * 10) * 10;
              if (current > percent) {
                percent = current;
                bucketProgress.update(getProgressMessage());
              }
            });
            uploader.on('end', () => {
              bucketProgress.remove();
              resolve('done');
            });
          });
        });
    });
    return Promise.all((promises))
      .then(() => {
        this.log.verbose('Removed objects from S3 buckets');
      })
      .finally(() => {
        taskProgress.remove();
      });
  }

  syncMetadata(invokedAsCommand) {
    let s3Sync = this.serverless.service.custom.s3Sync;
    if(s3Sync.hasOwnProperty('buckets')) {
      s3Sync = s3Sync.buckets;
    }
    if (!Array.isArray(s3Sync)) {
      this.log.error('serverless-s3-sync requires at least one configuration entry in custom.s3Sync');
      return Promise.resolve();
    }

    const taskProgress = this.progress.create({ message: 'Syncing bucket metadata' });

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
      let ignoreFiles = [];
      if(Array.isArray(s.params)) {
        s.params.forEach((param) => {
          const glob = Object.keys(param)[0];
          let files = this.getLocalFiles(localDir, []);
          minimatch.match(files, `${path.resolve(localDir)}${path.sep}${glob}`, {matchBase: true}).forEach((match) => {
            const params = this.extractMetaParams(param);
            if (ignoreFiles.includes(match)) return;
            if (params['OnlyForEnv'] && params['OnlyForEnv'] !== this.options.env) {
              ignoreFiles.push(match);
              filesToSync = filesToSync.filter(e => e.name !== match);
              return;
            }
            // to avoid Unexpected Parameter error
            delete params['OnlyForEnv'];
            filesToSync = filesToSync.filter(e => e.name !== match);
            filesToSync.push({name: match, params});
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

          const bucketDir = `${bucketName}${bucketPrefix == '' ? '' : bucketPrefix}/`;

          let percent = 0;
          const getProgressMessage = () => `${localDir}: sync bucket metadata to ${bucketDir} (${percent}%)`
          const bucketProgress = this.progress.create({ message: getProgressMessage() })

          return Promise.all(filesToSync.map((file, index) => {
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
                  CopySource: toS3Path(file.name.replace(path.resolve(localDir) + path.sep, bucketDir)),
                  Key: toS3Path(file.name.replace(path.resolve(localDir) + path.sep, `${bucketPrefix ? bucketPrefix.replace(/^\//, '') + '/' : ''}`)),
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
                const current = Math.round((index / filesToSync.length) * 10) * 10;
                if (current > percent) {
                  percent = current;
                  bucketProgress.update(getProgressMessage())
                }
                resolve('done');
              });
            });
          })).finally(() => {
            bucketProgress.remove();
          });
        });
    });
    return Promise.all((promises))
      .then(() => {
        if (invokedAsCommand) {
          this.log.success('Synced bucket metadata');
        } else {
          this.log.verbose('Synced bucket metadata');
        }
      })
      .finally(() => {
        taskProgress.remove();
      });
  }

  syncBucketTags(invokedAsCommand) {
    let s3Sync = this.serverless.service.custom.s3Sync;
    if(s3Sync.hasOwnProperty('buckets')) {
      s3Sync = s3Sync.buckets;
    }
    if (!Array.isArray(s3Sync)) {
      this.log.error('serverless-s3-sync requires at least one configuration entry in custom.s3Sync');
      return Promise.resolve();
    }

    const taskProgress = this.progress.create({ message: 'Updating bucket tags' });

    const promises = s3Sync.map( async (s) => {
      if (!s.bucketName && !s.bucketNameKey) {
        throw 'Invalid custom.s3Sync';
      }

      if (!s.bucketTags) {
        // bucket tags not configured for this bucket, skip it
        // so we don't require additional s3:getBucketTagging permissions
        return null;
      }

      // convert the tag key/value pairs into a TagSet structure for the putBucketTagging command
      const tagsToUpdate = Object.keys(s.bucketTags).map(tagKey => ({
        Key: tagKey,
        Value: s.bucketTags[tagKey]
      }));

      return this.getBucketName(s)
        .then(bucketName => {
          if (this.options && this.options.bucket && bucketName != this.options.bucket) {
            // if the bucket option is given, that means we're in the subcommand where we're
            // only syncing one bucket, so only continue if this bucket name matches
            return null;
          }

          const bucketProgress = this.progress.create({ message: `${bucketName}: sync bucket tags` })

          // AWS.S3 does not have an option to append tags to a bucket, it can only rewrite the whole set of tags
          // To avoid removing system tags set by other tools, we read the existing tags, merge our tags in the list
          // and then write them all back
          return this.client().s3.getBucketTagging({ Bucket: bucketName }).promise()
            .then(data => data.TagSet)
            .then(existingTagSet => {

              this.mergeTags(existingTagSet, tagsToUpdate);
              const putParams = {
                Bucket: bucketName,
                Tagging: {
                  TagSet: existingTagSet
                }
              };
              return this.client().s3.putBucketTagging(putParams).promise();
            })
            .finally(() => {
              bucketProgress.remove();
            });

        });
    });
    return Promise.all((promises))
      .then(() => {
        if (invokedAsCommand) {
          this.log.success('Updated bucket tags');
        } else {
          this.log.verbose('Updated bucket tags');
        }
      })
      .finally(() => {
        taskProgress.remove();
      });
  }

  mergeTags(existingTagSet, tagsToMerge) {
    tagsToMerge.forEach(tag => {
      const existingTag = existingTagSet.find(et => et.Key === tag.Key);
      if (existingTag) {
        existingTag.Value = tag.Value;
      } else {
        existingTagSet.push(tag);
      }
    });
  }

  getLocalFiles(dir, files) {
    try {
      fs.accessSync(dir, fs.constants.R_OK);
    } catch (e) {
      this.log.error(`The directory ${dir} does not exist.`);
      return files;
    }
    fs.readdirSync(dir).forEach(file => {
      let fullPath = path.join(dir, file);
      try {
        fs.accessSync(fullPath, fs.constants.R_OK);
      } catch (e) {
        this.log.error(`The file ${fullPath} does not exist.`);
        return;
      }
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
