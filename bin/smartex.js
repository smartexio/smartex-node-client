#!/usr/bin/env node

var isWin        = process.platform === 'win32';
var HOME         = process.env[isWin ? 'USERPROFILE' : 'HOME'];
var smartex       = require('commander');
var Smartex       = require('../index');
var fs           = require('fs');
var crypto       = require('crypto');
var read         = require('read');
var async        = require('async');
var bitauth      = require('bitauth');
var hashPassword = require('../lib/hash-password');
var CliUtils     = require('../lib/cli-utils');
var util         = require('util');
var path         = require('path');
var config       = require(HOME + '/.smartex/config');
var qs           = require('querystring');

// ensure the existence of the default in/out directory
if (!fs.existsSync(HOME + '/.smartex')) {
  fs.mkdirSync(HOME + '/.smartex');
}

smartex
  .version(require('../package').version)
  .option('-o, --output [directory]', 'export directory for keys', HOME + '/.smartex')
  .option('-i, --input [directory]', 'import directory for keys', HOME + '/.smartex')

var utils = new CliUtils(smartex.input, smartex.output);

smartex
  .command('keygen')
  .description('generate key pair to associate with your smartex user')
  .action(function() {

    function saveKeys() {
      getPassword(function(keypassword) {
        console.log('Generating keys...');

        var sin    = bitauth.generateSin();
        var secret = bitauth.encrypt(keypassword, sin.priv);
        var query  = qs.stringify({
          label: 'smartex-node-client-' + require('os').hostname(),
          id: sin.sin,
          facade: 'merchant'
        });

        fs.writeFileSync(smartex.output + '/api.key', secret);
        fs.writeFileSync(smartex.output + '/api.pub' , sin.sin);

        console.log('Keys saved to:', smartex.output, '\n');
        console.log('Your client identifier is:', sin.sin, '\n\n');

        process.exit();
      });
    };

    function getPassword(callback) {
      var keypassword = null;

      if (!smartex.keypassword) {
        return read({
          prompt: 'Key Password (optional): ',
          silent: true
        }, function(err, input) {
          if (err) {
            return console.log(err);
          }

          if (input) {
            keypassword = input;

            // check again to make sure there wasn't a typo
            return read({
              prompt: 'Verify Key Password: ',
              silent: true
            }, function(err, input2) {
              if (err) {
                return console.log(err);
              }

              if (keypassword === input2) {
                return callback(keypassword);
              }

              console.log('Passwords did not match');
              process.exit();
            });
          }

          callback(input);

        });
      }

      callback(smartex.keypassword)
    };

    var hasPrivateKey = fs.existsSync(smartex.output + '/api.key');
    var hasPublicKey  = fs.existsSync(smartex.output + '/api.pub');

    if (hasPrivateKey || hasPublicKey) {
      return smartex.confirm(
        'Keys already exist at ' + smartex.output + '. Do you wish to overwrite them?\n',
        function(ok) {
          if (ok) {
            return saveKeys()
          }

          console.log('Aborted.')
          process.exit();
        }
      );
    }

    saveKeys();

  });

smartex
  .command('pair')
  .description('receive a token for the cryptographically secure smartex api')
  .option('-c, --pairingcode <code>', 'smartex api pairing code')
  .action(function(cmd) {

    if (!fs.existsSync(smartex.input + '/api.key')) {
      return console.log('Error:', 'Access key not found, did you run `smartex keygen`?');
    }

    var sin    = fs.readFileSync(smartex.input + '/api.pub').toString();
    var client = Smartex.createClient();

    // handle errors
    client.on('error', function(err) {
      console.log('Error:', err);
    });

    function getInactiveToken(facade, callback){

      var payload = {
        id: sin,
        facade: facade,
        label: 'smartex-node-client-' + require('os').hostname()
      };

      client.as('public').post('tokens', payload, function(err, result) {
        if (err ) {
          return callback(err);
        }
        if (!result[0]) return callback(new Error('No token returned'));
        callback(null, result[0]);
      });

    }

    function claimToken(code, callback) {

      var payload = {
        id: sin,
        pairingCode: code,
        label: 'smartex-node-client'
      };

      client.as('public').post('tokens', payload, function(err, result) {
        if (err) {
          return callback(err);
        }
        if (!result[0]) return callback(new Error('No token returned'));
        return callback(null, result[0]);
      });

    }

    function promptPairingCode(callback){

      if ( cmd.pairingcode ) return callback(null, cmd.pairingcode);

      smartex.confirm(
        'Do you have a pairing code?',
        function(yes) {
          if (yes) {
            return read({
              prompt: 'Smartex Token Pairing Code: ',
              silent: false
            }, function(err, input) {
              if (err) {
                return callback(err);
              }
              callback(null, input);
            });
          }
          return callback(null, false);
        });

    }

    function pairWithClient(code, callback){

      if ( code ) {

        claimToken(code, function(err, token){

          if ( err ) return callback( err );

          return console.log('\n\n', 'Client successfully paired with `'+ token.facade + '` facade capabilities.', '\n\n');
          process.exit();

        });
      } else {
        callback(null)
      }

    }

    function retreivePairingCode(callback){

      console.log('Okay, we can get a pairing code, please choose a facade:');

      var list = {
        'Point of Sale': 'pos',
        'Merchant': 'merchant'
      }
      var listOptions = Object.keys(list)

      smartex.choose(listOptions, function(i){

        var facade = list[listOptions[i]];

        process.stdin.destroy();

        getInactiveToken(facade, function(err, token){

          if (err) callback( err );

          if ( !token.pairingCode ) {
            return console.log('No pairing code found');
          }

          var pairingCode = token.pairingCode;

          console.log(
            '\n',
            'Your token information:\n\n',
            'Client ID:\t'+sin,
            '\n',
            'Pairing Code:\t'+pairingCode,
            '\n',
            'Label:\t\t'+token.label,
            '\n',
            'Facade:\t'+token.facade,
            '\n'
          );

          var expirationDate = new Date( token.pairingExpiration );

          console.log(
            '\n',
            'Your pairing code will be available until: '+expirationDate,
            '\n'
          )

          console.log(
            '\n',
            'Pair this client with another organization by giving an administrator this pairing code:',
            '\n',
            pairingCode
          );

          var query  = qs.stringify({
            pairingCode: pairingCode
          });

          console.log(
            '\n',
            'Pair this client with your organization:',
            '\n',
            'https://' + config.apiHost +
              (config.apiPort === 443 ? '' : ':' + config.apiPort) +
              '/api-access-request?' + query,
            '\n\n'
          );

          callback(null);

        })
      })
    }

    async.waterfall([
      promptPairingCode,
      pairWithClient,
      retreivePairingCode
    ], function(err){
      if ( err ) console.log('Error:', err );
      process.exit();
    })

  });




smartex
  .command('unpair')
  .description('invalidate client identity from your smartex user')
  .action(function() {
    if (!fs.existsSync(smartex.input + '/api.key')) {
      return console.log(
        'Error:', 'Access key not found, did you run `smartex login`?'
      );
    }

    var sin = fs.readFileSync(smartex.input + '/api.pub').toString();

    utils.recursiveGetSecret(smartex.keypassword, function(secret) {
      var client = Smartex.createClient(secret, {
        sticky: true
      });

      // handle errors
      client.on('error', function(err) {
        console.log('Error:', err);
      });

      // associate key
      client.on('ready', function() {

        client.as('user').get('clients', function(err, clients) {
          if (err) {
            return console.log('Error:', err.error);
          }

          console.log('Invalidating keys...');

          clients.forEach(function(key) {
            if (key.id === sin) {
              key.put({
                disabled: true
              }, function(err) {
                if (err) {
                  return console.log('Error:', err.error);
                }

                console.log('Key invalidated successfully! Deleting keys...');

                fs.unlinkSync(smartex.input + '/api.pub');
                fs.unlinkSync(smartex.input + '/api.key');

                console.log('Done.');
                process.exit();
              });
            }
          });
        });
      });
    });
  });

smartex
  .command('whoami')
  .description('retrieve user information for your smartex user')
  .action(function() {
    if (!fs.existsSync(smartex.input + '/api.key')) {
      return console.log(
        'Error:', 'Access key not found, did you run `smartex login`?'
      );
    }

    utils.recursiveGetSecret(smartex.keypassword, function(secret) {
      var client = Smartex.createClient(secret);

      // handle errors
      client.on('error', function(err) {
        console.log('Error:', err);
      });

      // get user info
      client.on('ready', function() {
        client.as('user').get('user', function(err, user) {
          if (err) {
            return console.log('Error:', err.error);
          }

          console.log(
            '\nName: ' + user.name +
            '\nEmail: ' + user.email +
            '\nPhone: ' + user.phone
          );
        });
      });
    });

  });

smartex
  .command('request')
  .description('issue an api request')
  .option('-T, --token [token]', 'access token or facade name', 'public')
  .option('-X, --method [verb]', 'http method verb for request', 'GET')
  .option('-R, --resource <url_fragment>', 'url path to resource')
  .option('-P, --payload [body]', 'json string or file path')
  .action(function(cmd) {
    if (!cmd.resource) {
      return console.log(
        'Error:', 'You must specify a resource path using the -R option'
      );
    }

    async.waterfall(
      [
        getKeyPassword,
        createClient,
        assemblePayload,
        issueRequest
      ],
      function(err) {
        if (err) {
          console.log('Error:', util.inspect(err, {
            depth: null, colors: true
          }));
          process.exit(1);
        }
      }
    );

    function getKeyPassword(next) {
      if (cmd.token === 'public') {
        return next(null, null);
      }

      if (!fs.existsSync(smartex.input + '/api.key')) {
        return next(null, null);
      }

      utils.recursiveGetSecret(smartex.keypassword, function(secret) {
        next(null, secret);
      });
    };

    function createClient(secret, next) {
      var client = Smartex.createClient(secret);

      client.on('ready', function() {
        next(null, client);
      });

      client.on('error', function(err) {
        console.log('Error:', err);
        process.exit(1);
      });
    };

    function assemblePayload(client, next) {
      if (fs.existsSync(cmd.payload)) {
        var data = JSON.parse(fs.readFileSync(cmd.payload));
        return next(null, client, data);
      }

      next(null, client, cmd.payload ? JSON.parse(cmd.payload) : {});
    };

    function issueRequest(client, data, next) {
      var request = client.as(cmd.token)[cmd.method.toLowerCase()].bind(client);

      request(cmd.resource, data, function(err, data) {
        if (err) {
          return next(err);
        }

        console.log(util.inspect(data, {
          depth: null, colors: true
        }));
      });
    };

  });

smartex
  .command('config')
  .description('view and change configuration')
  .option('-p, --print', 'print the current configuration')
  .option('-l, --list', 'list available presets')
  .option('-u, --use <test|prod|custom>', 'use a preset configuration')
  .option('-S, --save <preset_name>', 'save current config as a preset')
  .option('-s, --set <property_name>', 'config property to change')
  .option('-v, --value <property_value>', 'value to change property to')
  .action(function(cmd) {
    var presets = fs.readdirSync(__dirname + '/../config')

    if (fs.existsSync(HOME + '/.smartex/presets')) {
      presets = presets.concat(fs.readdirSync(HOME + '/.smartex/presets'));
    }
    else {
      fs.mkdirSync(HOME + '/.smartex/presets');
    }

    if (cmd.print) {
      return console.log(
        util.inspect(config, {
          depth: null,
          colors: true
        })
      );
    }

    if (cmd.list) {
      return console.log(util.inspect(presets.map(function(p) {
        return path.basename(p, '.json');
      }), { colors: true }));
    }

    if (cmd.use) {
      if (presets.indexOf(cmd.use + '.json') === -1) {
        return console.log('Error: "' + cmd.use + '" is not a valid preset')
      }

      var incl   = fs.existsSync(__dirname + '/../config/' + cmd.use + '.json');
      var local  = HOME + '/.smartex/presets/';
      var dir    = incl ? __dirname + '/../config/' : local;
      var preset = dir + cmd.use + '.json'

      return fs.writeFileSync(
        HOME + '/.smartex/config.json',
        JSON.stringify(require(preset), null, 2)
      );
    }

    if (cmd.set && cmd.value) {
      var conf = require(HOME + '/.smartex/config');

      if (Object.keys(conf).indexOf(cmd.set) === -1) {
        return console.log('Error: "' + cmd.set + '" is not a valid property');
      }

      conf[cmd.set] = cmd.value;

      return fs.writeFileSync(
        HOME + '/.smartex/config.json',
        JSON.stringify(conf, null, 2)
      );
    }

    if (cmd.save) {
      var current = fs.readFileSync(HOME + '/.smartex/config.json');

      return fs.writeFileSync(
        HOME + '/.smartex/presets/' + cmd.save + '.json',
        current
      );
    }

    cmd.help();

  });

smartex.parse(process.argv);

if (!smartex.args.length) return smartex.help();
