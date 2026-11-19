

const Bluebird = require('bluebird');
const expect = require('chai').expect;
const sinon = require('sinon');
const tmp = require('tmp');
const fs = require('fs');
const PassThrough = require('stream').PassThrough;
const path = require('path');
const rimraf = require('rimraf');

const tmpNameAsync = Bluebird.promisify(tmp.tmpName);

const Reporter = require('../../lib/utils/reporter');
const FakeReporter = require('../support/fake_reporter');
const TapReporter = require('../../lib/reporters/tap_reporter');
const XUnitReporter = require('../../lib/reporters/xunit_reporter');

const fsReadFileAsync = Bluebird.promisify(fs.readFile);
const fsUnlinkAsync = Bluebird.promisify(fs.unlink);

describe('Reporter', function() {
  function mockApp(reporter) {
    reporter = reporter || new FakeReporter();

    return {
      config: {
        get: function(key) {
          switch (key) {
            case 'reporter':
              return reporter;
          }
        }
      }
    };
  }

  let sandbox, stream;

  beforeEach(function() {
    sandbox = sinon.createSandbox();
    stream = new PassThrough();
  });

  afterEach(function() {
    sandbox.restore();
  });

  describe('"new"', function() {
    it('can report to a file', function() {
      let close;
      tmpNameAsync().then(function(path) {
        return new Reporter(mockApp(), stream, path);
      }).then(function(reporter) {
        expect(reporter.reportFile).to.exist();

        close = sandbox.spy(reporter.reportFile, 'close');

        return reporter.close();
      }).then(function() {
        expect(close).to.have.been.called();
      });
    });

    // Regresses https://github.com/testem/testem/issues/900
    it('uses file stream when reporting', function() {
      let tapReporterSpy = sandbox.spy(require('../../lib/reporters'), 'tap');
      let reporter = new Reporter(mockApp('tap'), stream, 'report.xml');

      expect(reporter.reportFile).to.not.be.undefined();

      sinon.assert.calledWithMatch(tapReporterSpy,
        sinon.match.any,
        sinon.match.same(reporter.reportFile.outputStream),
        sinon.match.any,
        sinon.match.any);

      return reporter.close().then(function() {
        return fsUnlinkAsync('report.xml');
      });
    });
  });

  describe('"with"', function() {
    let app = mockApp();

    it('can be used as a disposable which returns a reporter', function() {
      return Bluebird.using(Reporter.with(app, stream), function(reporter) {
        expect(reporter).to.be.an.instanceof(Reporter);
      });
    });

    it('closes the reporter when done', function() {
      let close;
      return Bluebird.using(Reporter.with(app, stream), function(reporter) {
        close = sandbox.spy(reporter, 'close');
      }).then(function() {
        expect(close).to.have.been.called();
      });
    });

    it('closes the reporter when promise is rejected with error hidden from the reporter', function() {
      let close;
      return Bluebird.using(Reporter.with(app, stream), function(reporter) {
        close = sandbox.spy(reporter, 'close');

        let mockError = new Error('Not all tests passed.');
        mockError.hideFromReporter = true;
        return Bluebird.reject(mockError);
      }).catch(function() {
        expect(close).to.have.been.called();
      });
    });

    it('logs an error when the wrapped promise was rejected', function() {
      let report;

      return Bluebird.using(Reporter.with(app, stream), function(reporter) {
        report = sandbox.spy(reporter, 'report');
        return Bluebird.reject(new Error('Tests failed.'));
      }).catch(function() {
        expect(report).to.have.been.calledWith(null, {
          error: { message: 'Tests failed.' }, name: 'Error', passed: false
        });
      });
    });
  });

  describe('per-launcher files', function() {
    let directory;

    beforeEach(function() {
      directory = tmp.dirSync().name;
    });

    afterEach(function() {
      rimraf.sync(directory);
    });

    ['tap', 'xunit'].forEach(format => {
      it('keeps interleaved launcher results in separate ' + format + ' files', function() {
        const app = mockApp(format);
        app.runners = [
          { launcherId: 1, launcher: { name: 'Chrome' } },
          { launcherId: 2, launcher: { name: 'Firefox' } }
        ];
        const reporter = new Reporter(app, stream, path.join(directory, '<launcher>', 'results.txt'));
        reporter.onStart('Chrome 100', { launcherId: 1 });
        reporter.testStarted('Chrome', { launcherId: 1 });
        reporter.report('Chrome 100', { launcherId: 1, name: 'chrome-first', passed: true });
        reporter.report('Firefox 100', { launcherId: 2, name: 'firefox-only', passed: false });
        reporter.report('Chrome 100', { launcherId: 1, name: 'chrome-second', passed: true });
        reporter.onEnd('Chrome 100', { launcherId: 1 });

        return reporter.close().then(() => {
          const chrome = fs.readFileSync(path.join(directory, 'Chrome', 'results.txt'), 'utf8');
          const firefox = fs.readFileSync(path.join(directory, 'Firefox', 'results.txt'), 'utf8');
          expect(chrome).to.contain('chrome-first').and.contain('chrome-second');
          expect(chrome).not.to.contain('firefox-only');
          expect(firefox).to.contain('firefox-only');
          expect(firefox).not.to.contain('chrome-first');
          expect(reporter.total).to.equal(3);
          expect(reporter.hasPassed()).to.be.false();
          const output = stream.read().toString();
          expect(output).to.contain('chrome-first').and.contain('firefox-only');
        });
      });
    });

    ['tap', 'xunit', 'dot', 'teamcity'].forEach(format => {
      it('writes complete independent ' + format + ' reports and merges matching launcher names', function() {
        const app = mockApp(format);
        app.runners = [
          { launcherId: 1, launcher: { name: 'Chrome' } },
          { launcherId: 2, launcher: { name: 'Firefox' } },
          { launcherId: 3, launcher: { name: 'Chrome' } }
        ];
        const reporter = new Reporter(app, stream, path.join(directory, '<launcher>.txt'));
        reporter.onStart('testem', { launcherId: 0 });
        reporter.report('Chrome 100', { launcherId: 1, name: 'first', passed: true });
        reporter.report('Firefox 100', { launcherId: 2, name: 'broken', passed: false, error: { message: 'browser failed' } });
        reporter.report('Chrome 101', { launcherId: 3, name: 'second', skipped: true });
        reporter.report('testem', { launcherId: 0, name: 'hook', passed: true });
        reporter.onEnd('testem', { launcherId: 0 });
        const chromeReporter = reporter.launcherReports.get('Chrome').reporter;
        const firefoxReporter = reporter.launcherReports.get('Firefox').reporter;
        expect(chromeReporter.total).to.equal(2);
        expect(chromeReporter.pass).to.equal(1);
        expect(chromeReporter.skipped).to.equal(1);
        expect(firefoxReporter.total).to.equal(1);
        expect(firefoxReporter.pass).to.equal(0);
        expect(reporter.total).to.equal(4);
        expect(reporter.hasPassed()).to.be.false();
        const finish = sandbox.spy(chromeReporter, 'finish');
        reporter.finish();
        reporter.finish();

        return reporter.close().then(() => {
          sinon.assert.calledOnce(finish);
          expect(fs.readdirSync(directory).sort()).to.deep.equal(['Chrome.txt', 'Firefox.txt']);
          const chrome = fs.readFileSync(path.join(directory, 'Chrome.txt'), 'utf8');
          const firefox = fs.readFileSync(path.join(directory, 'Firefox.txt'), 'utf8');
          const output = stream.read().toString();
          if (format === 'tap' || format === 'dot') {
            expect(chrome).to.contain('# tests 2').and.contain('# pass  1');
            expect(firefox).to.contain('# tests 1').and.contain('# fail  1');
            expect(output).to.contain('# tests 4');
          } else if (format === 'xunit') {
            expect(chrome).to.contain('tests="2"').and.contain('skipped="1"').and.contain('failures="0"');
            expect(firefox).to.contain('tests="1"').and.contain('failures="1"');
            expect((chrome.match(/<testsuite /g) || [])).to.have.lengthOf(1);
            expect(output).to.contain('tests="4"');
          } else {
            expect((chrome.match(/##teamcity\[testFinished /g) || [])).to.have.lengthOf(2);
            expect((chrome.match(/##teamcity\[testSuiteFinished /g) || [])).to.have.lengthOf(1);
            expect(firefox).to.contain('##teamcity[testFailed ');
            expect((output.match(/##teamcity\[testFinished /g) || [])).to.have.lengthOf(4);
          }
          expect(chrome).not.to.contain('browser failed');
          expect(firefox).to.contain('browser failed');
        });
      });
    });

    it('waits for every file to close and reuses the close promise', function() {
      const reporter = new Reporter(mockApp('tap'), stream, path.join(directory, '<launcher>.txt'));
      reporter.report('Chrome', { name: 'first', passed: true });
      reporter.report('Firefox', { name: 'second', passed: true });
      let resolveChrome, resolveFirefox;
      const chromeReady = new Bluebird(resolve => { resolveChrome = resolve; });
      const firefoxReady = new Bluebird(resolve => { resolveFirefox = resolve; });
      [chromeReady, firefoxReady].forEach((ready, index) => {
        const file = Array.from(reporter.launcherReports.values())[index].file;
        const close = file.close.bind(file);
        sandbox.stub(file, 'close').callsFake(() => close().then(() => ready));
      });
      const closing = reporter.close();
      expect(reporter.close()).to.equal(closing);
      let closed = false;
      closing.then(() => { closed = true; });
      resolveChrome();
      return Bluebird.delay(10).then(() => {
        expect(closed).to.be.false();
        resolveFirefox();
        return closing;
      }).then(() => {
        expect(fs.readFileSync(path.join(directory, 'Chrome.txt'), 'utf8')).to.contain('first');
        expect(fs.readFileSync(path.join(directory, 'Firefox.txt'), 'utf8')).to.contain('second');
      });
    });

    it('keeps internal errors on stdout without creating launcher files', function() {
      const reporter = new Reporter(mockApp('tap'), stream, path.join(directory, '<launcher>.txt'));
      reporter.report(null, { name: 'internal failure', passed: false });
      return reporter.close().then(() => {
        expect(fs.readdirSync(directory)).to.deep.equal([]);
        expect(stream.read().toString()).to.contain('internal failure');
        expect(reporter.hasPassed()).to.be.false();
      });
    });

    it('keeps all launchers in one file when the launcher template is absent', function() {
      const filename = path.join(directory, 'combined.xml');
      const reporter = new Reporter(mockApp('xunit'), stream, filename);
      reporter.report('Chrome', { name: 'chrome test', passed: true });
      reporter.report('Firefox', { name: 'firefox test', passed: false });
      reporter.report('testem', { launcherId: 0, name: 'hook', passed: true });
      reporter.finish();
      reporter.finish();
      const closing = reporter.close();
      expect(reporter.close()).to.equal(closing);
      return closing.then(() => {
        const output = fs.readFileSync(filename, 'utf8');
        expect(output).to.contain('chrome test').and.contain('firefox test').and.contain('hook');
        expect(output).to.contain('tests="3"').and.contain('failures="1"');
        expect((output.match(/<testsuite /g) || [])).to.have.lengthOf(1);
        expect(fs.readdirSync(directory)).to.deep.equal(['combined.xml']);
        expect(reporter.hasPassed()).to.be.false();
      });
    });

    it('preserves xunit intermediate TAP output with launcher templates', function() {
      const app = mockApp('xunit');
      const get = app.config.get;
      app.config.get = key => key === 'xunit_intermediate_output' ? true : get(key);
      const reporter = new Reporter(app, stream, path.join(directory, '<launcher>.xml'));
      reporter.report('Firefox', { name: 'example', passed: true });
      return reporter.close().then(() => {
        expect(stream.read().toString()).to.contain('# tests 1');
        expect(fs.readFileSync(path.join(directory, 'Firefox.xml'), 'utf8')).to.contain('<testsuite');
      });
    });
  });

  describe('new', function() {
    it('creates a reporter and writes to stream', function() {
      let reporter = new Reporter({
        config: {
          get: function(key) {
            switch (key) {
              case 'reporter':
                return 'tap';
            }
          }
        }
      }, stream);

      expect(reporter.reporters.length).to.eq(1);

      reporter.report('phantomjs', {
        name: 'it does <cool> "cool" \'cool\' stuff',
        passed: true
      });
      reporter.finish();

      let output = stream.read().toString();
      expect(output).to.match(/tests 1/);
    });

    it('creates two reporters and writes to stream and path when path provided', function() {
      return tmpNameAsync().then(function(path) {
        let stream = new PassThrough();
        let reporter = new Reporter({
          config: {
            get: function(key) {
              switch (key) {
                case 'reporter':
                  return 'tap';
              }
            }
          }
        }, stream, path);

        reporter.report('phantomjs', {
          name: 'it does <cool> "cool" \'cool\' stuff',
          passed: true
        });

        reporter.finish();

        return reporter.close().then(function() {
          let output = stream.read().toString();
          expect(output).to.match(/tests 1/);

          return fsReadFileAsync(path, 'utf-8');
        }).then(function(output) {
          expect(output).to.match(/tests 1/);
        });
      });
    });

    it('creates two reporters in dev mode if path is present and 2nd reporter is tap', function() {
      return tmpNameAsync().then(function(path) {
        let stream = new PassThrough();
        let reporter = new Reporter({
          config: {
            appMode: 'dev',
            get: function(key) {
              switch (key) {
                case 'reporter':
                  return FakeReporter;
                case 'path':
                  return 'dev';
                case 'url':
                  return 'abc';
              }
            }
          },
          on: () => {},
        }, stream, path);

        expect(reporter.reporters).to.have.lengthOf(2);
        expect(reporter.reporters[0]).to.be.an.instanceof(FakeReporter);
        expect(reporter.reporters[1]).to.be.an.instanceof(TapReporter);
      });
    });

    it('creates two reporters in dev mode if path is present and 2nd reporter is dev_mode_file_reporter', function() {
      return tmpNameAsync().then(function(path) {
        let stream = new PassThrough();
        let reporter = new Reporter({
          config: {
            appMode: 'dev',
            get: function(key) {
              switch (key) {
                case 'reporter':
                  return FakeReporter;
                case 'path':
                  return 'dev';
                case 'dev_mode_file_reporter':
                  return 'xunit';
                case 'url':
                  return 'abc';
              }
            }
          },
          on: () => {},
        }, stream, path);

        expect(reporter.reporters).to.have.lengthOf(2);
        expect(reporter.reporters[0]).to.be.an.instanceof(FakeReporter);
        expect(reporter.reporters[1]).to.be.an.instanceof(XUnitReporter);
      });
    });

    it('creates a reporter when custom reporter dependent on configs is provided', function() {
      class CustomReporter extends TapReporter {
      }

      let config = { get: sinon.stub() };
      config.get.withArgs('reporter').returns(CustomReporter);
      config.get.withArgs('tap_quiet_logs').returns(true);
      let app = { config: config };
      let reporter = new Reporter(app, stream);

      expect(reporter).to.be.ok();
      expect(reporter.reporters.length).to.equal(1);
      expect(reporter.reporters[0].quietLogs).to.be.true();
    });

    it('writes xml to stream and file with xunit reporter and intermediate output is enabled', function() {
      return tmpNameAsync().then(function(path) {
        let stream = new PassThrough();
        let reporter = new Reporter({
          config: {
            get: function(key) {
              switch (key) {
                case 'reporter':
                  return 'xunit';
                case 'xunit_intermediate_output':
                  return false;
              }
            }
          }
        }, stream, path);

        reporter.report('phantomjs', {
          name: 'it does <cool> "cool" \'cool\' stuff',
          passed: true
        });
        reporter.finish();

        return reporter.close().then(function() {
          let output = stream.read().toString();
          expect(output).to.match(/<testsuite name/);

          return fsReadFileAsync(path, 'utf-8');
        }).then(function(output) {
          expect(output).to.match(/<testsuite name/);
        });
      });
    });

    it('writes tap to stream and xml to file with xunit reporter intermediate output is enabled', function() {
      return tmpNameAsync().then(function(path) {
        let stream = new PassThrough();
        let reporter = new Reporter({
          config: {
            get: function(key) {
              switch (key) {
                case 'reporter':
                  return 'xunit';
                case 'xunit_intermediate_output':
                  return true;
              }
            }
          }
        }, stream, path);

        reporter.report('phantomjs', {
          name: 'it does <cool> "cool" \'cool\' stuff',
          passed: true
        });
        reporter.finish();

        return reporter.close().then(function() {
          let output = stream.read().toString();
          expect(output).to.match(/tests 1/);

          return fsReadFileAsync(path, 'utf-8');
        }).then(function(output) {
          expect(output).to.match(/<testsuite name/);
        });
      });
    });
  });

  describe('hasPassed', function() {
    let app = mockApp();
    let reporter;

    beforeEach(function() {
      reporter = new Reporter(app, stream);
    });

    it('returns true when all tests passed', function() {
      reporter.report('test', { passed: 1 });

      expect(reporter.hasPassed()).to.be.true();
    });

    it('returns true when all tests skipped', function() {
      let reporter = new Reporter(app, stream);

      reporter.report('test', { skipped: 1 });

      expect(reporter.hasPassed()).to.be.true();
    });

    it('returns true when all tests skipped or passed', function() {
      let reporter = new Reporter(app, stream);

      reporter.report('test', { passed: 1 });
      reporter.report('test', { skipped: 1 });

      expect(reporter.hasPassed()).to.be.true();
    });

    it('returns false when not all passed / skipped', function() {
      let reporter = new Reporter(app, stream);

      reporter.report('test', { passed: 1 });
      reporter.report('test', { skipped: 1 });
      reporter.report('test', { });

      expect(reporter.hasPassed()).to.be.false();
    });
  });

  describe('hasTests', function() {
    let app = mockApp();
    let reporter;

    beforeEach(function() {
      reporter = new Reporter(app, stream);
    });

    it('returns false without reported tests', function() {
      let reporter = new Reporter(app, stream);

      expect(reporter.hasTests()).to.be.false();
    });

    it('returns true when tests were reported', function() {
      reporter.report('test', {});

      expect(reporter.hasTests()).to.be.true();
    });
  });
});
