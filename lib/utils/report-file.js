

const fs = require('fs');
const path = require('path');
const mkdirp = require('mkdirp');
const PassThrough = require('stream').PassThrough;
const Bluebird = require('bluebird');

module.exports = class ReportFile {
  constructor(reportFile, options) {
    this.file = ReportFile.expandPath(reportFile, options);

    this.outputStream = new PassThrough();

    mkdirp.sync(path.dirname(path.resolve(this.file)));

    this.outputStream = fs.createWriteStream(this.file, { flags: 'w+' });

    let alreadyEnded = false;
    function finish(data) {
      if (!alreadyEnded) {
        alreadyEnded = true;
        this.outputStream.end(data);
      }
    }

    this.outputStream.on('end', finish);
    this.outputStream.on('error', finish);

    this.closePromise = new Bluebird.Promise((resolve, reject) => {
      this.outputStream.on('finish', resolve);
      this.outputStream.on('error', reject);
    });
  }

  getFilePath() {
    return this.file;
  }

  static expandPath(reportFile, options = {}) {
    if (reportFile === null || reportFile === undefined) {
      return reportFile;
    }

    const date = options.date || new Date();
    const pad = value => ('0' + value).slice(-2);
    const dateString = [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join('-');
    const timestamp = dateString + '_' + [date.getHours(), date.getMinutes(), date.getSeconds()].map(pad).join('-');

    return reportFile.replace(/<launcher>|<date>|<timestamp>/g, template => {
      switch (template) {
        case '<launcher>': return options.launcher || '';
        case '<date>': return dateString;
        case '<timestamp>': return timestamp;
      }
    });
  }

  static hasLauncherTemplate(reportFile) {
    return typeof reportFile === 'string' && reportFile.indexOf('<launcher>') !== -1;
  }

  static hasDateTemplate(reportFile) {
    return typeof reportFile === 'string' && reportFile.indexOf('<date>') !== -1;
  }

  static hasTimestampTemplate(reportFile) {
    return typeof reportFile === 'string' && reportFile.indexOf('<timestamp>') !== -1;
  }

  close() {
    this.outputStream.end();

    return this.closePromise;
  }
};
