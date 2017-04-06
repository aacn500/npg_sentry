// Adapted from example at
// http://gruntjs.com/getting-started#an-example-gruntfile

'use strict';

module.exports = function(grunt) {
  require('load-grunt-tasks')(grunt);

  grunt.initConfig({
    pkg: grunt.file.readJSON('package.json'),
    uglify: {
      options: {
        banner:
          '/*! <%= pkg.name %> <%= grunt.template.today("yyyy-mm-dd") %>\n' +
          ' * Copyright (C) 2017 Genome Research Ltd\n' +
          ' */'
      },
      build: {
        src: 'sentry/public/js/script.js',
        dest: 'sentry/public/js/script.min.js'
      }
    },
    cssmin: {
      target: {
        files: {
          'sentry/public/css/styles.min.css': 'sentry/public/css/styles.css'
        }
      }
    },
    clean: {
      coverage: [ 'coverage' ],
      docs: [ 'docs' ],
    },
    jsdoc: {
      src: [ 'npg_sentry.js', 'lib/**/*.js' ],
      options: {
        destination: 'docs',
      }
    },
    eslint: {
      target: [
        'Gruntfile.js',
        'npg_sentry.js',
        'lib/*.js',
        'sentry/public/js/*.js',
        'test/**/*.js',
        '!**/*.min.js', // don't lint minified files
      ]
    },
    jsonlint: {
      pkg: {
        src: [
          'package.json',
          'bower.json',
          'lib/messages.json'
        ]
      }
    },
    qunit: {
      options: {
        timeout: 5000,
        console: true,
        '--debug': true
      },
      all: ['test/client/test*.html']
    },
    jasmine_node: {
      selenium: {
        options: {
          forceExit: true,
          coverage: false,
          jasmine: {
            verbosity: 4,
            spec_dir: 'test/selenium',
            spec_files: [
              '**/*spec.js'
            ],
          },
        },
        src: ['lib/**/*.js'],
      },
      only_test: {
        options: {
          forceExit: true,
          coverage: false,
          jasmine: {
            verbosity: 4,
            spec_dir: 'test/server',
            spec_files: [
              '**/*spec.js'
            ]
          }
        },
        src: ['lib/**/*.js']
      },
      coverage: {
        options: {
          forceExit: true,
          coverage: {
            includeAllSources: true
          },
          jasmine: {
            verbosity: 4,
            spec_dir: 'test/server',
            spec_files: [
              '**/*spec.js'
            ]
          }
        },
        src: ['lib/**/*.js']
      }
    }
  });

  grunt.registerTask('default', ['test']);
  grunt.registerTask('lint', ['eslint']);
  grunt.registerTask('selenium', () => {
    if (!process.version.match(/^v6\.[\d]+\.[\d]+$/)) {
      grunt.log.error('Selenium only runs with latest node LTS! (currently v6)');
    } else {
      grunt.task.run('jasmine_node:selenium');
    }
  });

  //grunt.registerTask('test',
  //  ['jsonlint', 'lint', 'jasmine_node:only_test', 'qunit', 'jasmine_node:selenium']);

  grunt.registerTask('test', () => {
    // Selenium only runs with latest LTS (currently v6) and may fail with older
    if (process.version.match(/^v6\.[\d]+\.[\d]+$/)) {
      grunt.task.run(['jsonlint', 'lint', 'jasmine_node:only_test', 'qunit', 'jasmine_node:selenium']);
    } else {
      grunt.log.writeln('Selenium only runs with latest node LTS (currently v6); skipping...');
      grunt.task.run(['jsonlint', 'lint', 'jasmine_node:only_test', 'qunit']);
    }
  });

  grunt.registerTask('test_coverage', () => {
    // Selenium only runs with latest LTS (currently v6) and may fail with older
    if (process.version.match(/^v6\.[\d]+\.[\d]+$/)) {
      grunt.task.run(['lint', 'clean:coverage', 'jasmine_node:coverage', 'qunit', 'jasmine_node:selenium']);
    } else {
      grunt.log.writeln('Selenium only runs with latest node LTS (currently v6); skipping...');
      grunt.task.run(['lint', 'clean:coverage', 'jasmine_node:coverage', 'qunit']);
    }
  });

  grunt.registerTask('minify', ['newer:uglify', 'newer:cssmin']);
};
