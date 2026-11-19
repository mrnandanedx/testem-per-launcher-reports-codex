

const Bluebird = require('bluebird');
const expect = require('chai').expect;
const tmp = require('tmp');
const Writable = require('stream').Writable;
const fs = require('fs');
const path = require('path');
const sinon = require('sinon');
const rimraf = require('rimraf');

const tmpNameAsync = Bluebird.promisify(tmp.tmpName);

const ReportFile = require('../../lib/utils/report-file');

describe('ReportFile', function() {
  describe('path templates', function() {
    const date = new Date(2026, 0, 2, 3, 4, 5);

    it('expands all occurrences of launcher, date and timestamp', function() {
      expect(ReportFile.expandPath('<date>/<launcher>/<timestamp>-<launcher>.xml', {
        launcher: 'Headless Chrome', date: date
      })).to.equal('2026-01-02/Headless Chrome/2026-01-02_03-04-05-Headless Chrome.xml');
    });

    it('uses the current local date when no date is supplied', function() {
      const clock = sinon.useFakeTimers(date.getTime());
      try {
        expect(ReportFile.expandPath('<date>_<timestamp>')).to.equal('2026-01-02_2026-01-02_03-04-05');
      } finally {
        clock.restore();
      }
    });

    it('preserves ordinary paths and unknown templates', function() {
      expect(ReportFile.expandPath('reports/<unknown>.xml')).to.equal('reports/<unknown>.xml');
    });

    ['Launcher', 'Date', 'Timestamp'].forEach(template => {
      it('detects the ' + template + ' template and handles absent paths', function() {
        const hasTemplate = ReportFile['has' + template + 'Template'];
        expect(hasTemplate('reports/<' + template.toLowerCase() + '>.xml')).to.be.true();
        [null, undefined, '', 'report.xml', '<unknown>'].forEach(value => {
          expect(hasTemplate(value)).to.be.false();
        });
      });
    });

    it('creates missing parent directories using the expanded path', function() {
      const dir = tmp.dirSync();
      const reportFile = new ReportFile(path.join(dir.name, '<date>', '<launcher>', 'report.xml'), {
        launcher: 'Firefox', date: date
      });
      const expected = path.join(dir.name, '2026-01-02', 'Firefox', 'report.xml');
      expect(reportFile.getFilePath()).to.equal(expected);
      reportFile.outputStream.write('results');
      return reportFile.close().then(() => {
        expect(fs.readFileSync(expected, 'utf8')).to.equal('results');
      }).finally(() => rimraf.sync(dir.name));
    });
  });

  describe('close', function() {
    it('resolves when all data has been written', function() {

      let noopStream = new Writable();
      noopStream._write = function(chunk, encoding, done) {
        done();
      };

      let finished = false;

      return tmpNameAsync().then(function(path) {
        return new ReportFile(path, noopStream);
      }).then(function(reportFile) {
        expect(reportFile.closePromise).to.exist();

        reportFile.outputStream.on('finish', function() {
          finished = true;
        });

        return reportFile.close();
      }).then(function() {
        expect(finished).to.be.true();
      });
    });
  });
});
