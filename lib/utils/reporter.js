

const Bluebird = require('bluebird');
const log = require('npmlog');

const reporters = require('../reporters');
const isa = require('./isa');
const ReportFile = require('./report-file');

function setupReporter(name, out, config, app) {
  let reporter;

  if (isa(name, String)) {
    let TestReporter = reporters[name];
    if (TestReporter) {
      reporter = new TestReporter(false, out, config, app);
    }
  } else if (isa(name, Function)) {
    // name is a constructor function, ignore new-cap and instantiate
    // eslint-disable-next-line new-cap
    reporter = new name(false, out, config, app);
  } else {
    reporter = name;
  }

  if (!reporter) {
    throw new Error('Test reporter `' + name + '` not found.');
  }

  return reporter;
}


class Reporter {
  constructor(app, stdout, path) {
    this.total = 0;
    this.passed = 0;
    this.skipped = 0;
    this.todo = 0;

    this.app = app;
    this.reportDate = new Date();
    this.launcherReports = new Map();
    if (ReportFile.hasLauncherTemplate(path)) {
      this.launcherReportPath = path;
      path = undefined;
    }

    if (path) {
      this.reportFile = new ReportFile(path);
    }

    let config = app.config;

    if ((path || this.launcherReportPath) && config.get('xunit_intermediate_output') && config.get('reporter') === 'xunit') {
      this.reporters = [
        setupReporter('tap', stdout, config, app)
      ];
      if (path) {
        this.reporters.push(setupReporter(config.get('reporter'), this.reportFile.outputStream, config, app));
      }
    } else {
      this.reporters = [setupReporter(config.get('reporter'), stdout, config, app)];

      if (path) {
        if (config.appMode === 'dev') {
          let devModeFileReporter = config.get('dev_mode_file_reporter');
          if (!devModeFileReporter) {
            log.warn('You configured a `report_file`, you may want to configure the `dev_mode_file_reporter` as well. Using the `tap` logger now.');
            devModeFileReporter = 'tap';
          }
          this.reporters.push(setupReporter(devModeFileReporter, this.reportFile.outputStream, config, app));
        } else {
          this.reporters.push(setupReporter(config.get('reporter'), this.reportFile.outputStream, config, app));
        }
      }
    }
  }

  testStarted(name, data) {
    this.reportersFor(name, data).forEach(reporter => {
      if (reporter.testStarted) {
        reporter.testStarted(name, data);
      }
    });
  }

  close() {
    if (this.closePromise) {
      return this.closePromise;
    }

    this.finish();

    if (this.launcherReportPath) {
      this.closePromise = Bluebird.all(Array.from(this.launcherReports.values(), entry => entry.file.close()));
      return this.closePromise;
    }

    if (this.reportFile) {
      this.closePromise = this.reportFile.close();
      return this.closePromise;
    }
  }

  finish() {
    if (this.finished) {
      return;
    }

    this.finished = true;
    forwardToReporters('finish').call(this);
  }

  hasTests() {
    return this.total > 0;
  }

  reportersFor(name, data) {
    if (!this.launcherReportPath || !name || name === 'testem' || (data && data.launcherId === 0)) {
      return this.reporters;
    }

    const runner = data && (this.app.runners || []).find(runner => runner.launcherId === data.launcherId);
    const launcher = runner ? runner.launcher.name : name || 'testem';
    if (!this.launcherReports.has(launcher)) {
      const config = this.app.config;
      let reporterName = config.get('reporter');
      if (config.appMode === 'dev') {
        reporterName = config.get('dev_mode_file_reporter') || 'tap';
      }
      const file = new ReportFile(this.launcherReportPath, { launcher: launcher, date: this.reportDate });
      const reporter = setupReporter(reporterName, file.outputStream, config, this.app);
      if (reporter.setLauncherName) {
        reporter.setLauncherName(launcher);
      }
      this.launcherReports.set(launcher, { file: file, reporter: reporter });
    }

    return this.reporters.concat(this.launcherReports.get(launcher).reporter);
  }

  hasPassed() {
    return this.total <= ((this.passed || 0) + (this.skipped || 0) + (this.todo || 0));
  }

  report(name, result) {
    this.total++;
    if (result.skipped) {
      this.skipped++;
    } else if (result.passed && !result.todo) {
      this.passed++;
    } else if (!result.passed && result.todo) {
      this.todo++;
    }

    this.reportersFor(name, result).forEach(reporter => {
      reporter.report(name, result);
    });
  }
}

Reporter.with = (app, stdout, path) => Bluebird.try(() => new Reporter(app, stdout, path)).disposer((reporter, promise) => {
  if (promise.isRejected()) {
    let err = promise.reason();

    if (!err.hideFromReporter) {
      reporter.report(null, {
        passed: false,
        name: err.name || 'unknown error',
        error: {
          message: err.message
        }
      });
    }
  }

  return reporter.close();
});

function forwardToReporters(fn) {
  return function() {
    let args = new Array(arguments.length);
    for (let i = 0; i < args.length; ++i) {
      args[i] = arguments[i];
    }

    let targets = this.reporters;
    if (fn === 'onStart' || fn === 'onEnd') {
      targets = this.reportersFor(args[0], args[1]);
    } else {
      targets = targets.concat(Array.from(this.launcherReports.values(), entry => entry.reporter));
    }
    targets.forEach(reporter => {
      if (reporter[fn]) {
        reporter[fn].apply(reporter, args);
      }
    });
  };
}

['onStart', 'onEnd', 'reportMetadata'].forEach(fn => {
  Reporter.prototype[fn] = forwardToReporters(fn);
});

module.exports = Reporter;
