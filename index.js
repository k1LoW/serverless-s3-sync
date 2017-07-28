'use strict';

const BbPromise = require('bluebird');
const AWS = require('aws-sdk');
const s3 = require('@monolambda/s3');
const client = s3.createClient({
  s3Client: new AWS.S3({})
});
const chalk = require('chalk');

class ServerlessS3Sync {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options || {};
    this.s3Sync = this.serverless.service.custom.s3Sync;
    this.servicePath = this.serverless.service.serverless.config.servicePath;

    this.commands = {
      s3sync: {
        usage: "Sync directories and S3 prefixes",
        lifecycleEvents: [
          'sync'
        ]
      }
    };

    this.hooks = {
      'after:deploy:deploy': () => BbPromise.bind(this).then(this.sync),
      'before:remove:remove': () => BbPromise.bind(this).then(this.clear),
      's3sync:sync': () => BbPromise.bind(this).then(this.sync)
    };
  }

  sync() {
    if (!Array.isArray(this.s3Sync)) {
      return Promise.resolve();
    }
    const cli = this.serverless.cli;
    const messagePrefix = 'S3 Sync: ';
    cli.consoleLog(`${messagePrefix}${chalk.yellow('Syncing directories and S3 prefixes...')}`);
    const servicePath = this.servicePath;
    const promises = this.s3Sync.map((s) => {
      if (!s.hasOwnProperty('bucketPrefix')) {
        s.bucketPrefix = '';
      }
      if (!s.bucketName || !s.localDir) {
        throw 'Invalid custom.s3Sync';
      }
      return new Promise((resolve) => {
        const params = {
          maxAsyncS3: 5,
          localDir: servicePath + '/' + s.localDir,
          deleteRemoved: true,
          followSymlinks: false,
          s3Params: {
            Bucket: s.bucketName,
            Prefix: s.bucketPrefix
          }
        };
        const uploader = client.uploadDir(params);
        uploader.on('error', (err) => {
          throw err;
        });
        let percent = 0;
        uploader.on('progress', () => {
          if (uploader.progressTotal === 0) {
            return;
          }
          let current = Math.round(uploader.progressAmount/uploader.progressTotal * 10) * 10;
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
    return Promise.all(promises)
      .then(() => {
        cli.printDot();
        cli.consoleLog('');
        cli.consoleLog(`${messagePrefix}${chalk.yellow('Synced.')}`);
      });
  }

  clear() {
    if (!Array.isArray(this.s3Sync)) {
      return Promise.resolve();
    }
    const cli = this.serverless.cli;
    const messagePrefix = 'S3 Sync: ';
    cli.consoleLog(`${messagePrefix}${chalk.yellow('Removing S3 objects...')}`);
    const promises = this.s3Sync.map((s) => {
      if (!s.hasOwnProperty('bucketPrefix')) {
        s.bucketPrefix = '';
      }
      return new Promise((resolve) => {
        const params = {
          Bucket: s.bucketName,
          Prefix: s.bucketPrefix
        };
        const uploader = client.deleteDir(params);
        uploader.on('error', (err) => {
          throw err;
        });
        let percent = 0;
        uploader.on('progress', () => {
          if (uploader.progressTotal === 0) {
            return;
          }
          let current = Math.round(uploader.progressAmount/uploader.progressTotal * 10) * 10;
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
    return Promise.all(promises)
      .then(() => {
        cli.printDot();
        cli.consoleLog('');
        cli.consoleLog(`${messagePrefix}${chalk.yellow('Removed.')}`);
      });
  }
}

module.exports = ServerlessS3Sync;
