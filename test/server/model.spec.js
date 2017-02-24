'use strict';

const child = require('child_process');

const decache = require('decache');
const moment = require('moment');
const MongoClient = require('mongodb').MongoClient;
const Promise = require('bluebird');
const fse = require('fs-extra');
const tmp = require('tmp');

let config = require('../../lib/config');
config.provide(() => {return {mongourl: 'mongodb://localhost:27017/test'};});
let model = require('../../lib/model');

let p_db;
let tmpobj;
let tmpdir;

function getCollection(collName) {
  return function(db) {
    return new Promise(function(resolve, reject) {
      db.collection(collName, function(err, collection) {
        if (err) {
          reject(err);
        } else {
          resolve(collection);
        }
      });
    });
  };
}

beforeAll(function(done) {
  // setup a mongo instance
  tmpobj = tmp.dirSync({prefix: 'npg_sentry_test_'});
  tmpdir = tmpobj.name;
  let command =
    `mongod --port 27017 --fork --dbpath ${tmpdir} ` +
    `--logpath ${tmpdir}/test_db.log --bind_ip 127.0.0.1`;
  console.log(`\nStarting MongoDB daemon: ${command}`);
  let out = child.execSync(command);
  console.log(`MongoDB daemon started: ${out}`);
  child.execSync('./test/scripts/wait-for-it.sh -q -h 127.0.0.1 -p 27017');
  p_db = MongoClient.connect('mongodb://localhost:27017/test',
          {promiseLibrary: Promise});
  p_db.then(done);
}, 25000);


afterAll(function(done) {
  child.execSync(
    `mongo 'mongodb://localhost:27017/admin' --eval 'db.shutdownServer()'`
  );
  console.log('\nMongoDB daemon has been switched off');
  fse.remove(tmpdir, function(err) {
    if (err) {
      console.log(`Error removing ${tmpdir}: ${err}`);
    }
    done();
  });
});


describe('DbError', function() {

  it('is a subclass of Error', function() {
    let err = new model.DbError('something bad');
    expect(err.name).toBe('DbError');
    expect(err instanceof model.DbError).toBe(true);
    expect(err instanceof Error).toBe(true);
    expect(require('util').isError(err)).toBe(true);
    expect(err.stack).toBeDefined();
    expect(err.toString()).toBe('DbError: something bad');
  });

});


describe('mongo connection error', function() {
  beforeAll(function() {
    decache('../../lib/model');
    config.provide(() => {return {mongourl: 'mongodb://invalid:27017/test'};});
    model = require('../../lib/model');
  });

  afterAll(function() {
    decache('../../lib/model');
    config.provide(() => {return {mongourl: 'mongodb://localhost:27017/test'};});
    model = require('../../lib/model');
  });

  it('is raised', function(done) {
    let user = 'user@example.com';
    let p_insert = model.createToken(user, 'test creation');
    p_insert.catch(function(reason) {
      expect(reason).not.toBeUndefined();
      done();
    });
  });
});


describe('exported function', function() {

  beforeEach(function() {
    child.execSync('mongo --eval "db.tokens.drop();db.users.drop();"');
  });

  describe('createToken', function() {

    it('succeeds', function(done) {
      let user = 'user@example.com';
      let p_insert = model.createToken(user, 'test creation');

      let p_collection = p_db.then(getCollection('tokens'));

      let p_cursor = p_collection.then(function(collection) {
        return p_insert.then(function() {
          return new Promise(function(resolve, reject) {
            try {
              resolve(collection.find({user}));
            } catch (err) {
              fail(err);
              reject(err);
            }
          });
        });
      });

      let p_count = p_cursor.then(function(cursor) {
        cursor.rewind();
        return cursor.count();
      });

      let p_countExpectation = p_count.then(function(count) {
        expect(count).toBe(1);
      });

      let p_doc = p_cursor.then(function(cursor) {
        cursor.rewind();
        return cursor.next();
      });

      let p_insertTest = p_insert.then(function(doc) {
        // test document returned by createToken
        expect(doc).toBeDefined();
        expect(doc.user).toBe(user);
        expect(doc.token).toMatch(/^[a-zA-Z0-9_-]{32}$/gm);
        expect(doc.status).toBe(model.TOKEN_STATUS_VALID);
        expect(moment(doc.issueTime).isValid()).toBe(true);
        expect(doc.creationReason).toBe('test creation');
        expect(moment(doc.expiryTime).isValid()).toBe(true);
        expect(moment(doc.expiryTime)
          .isBetween(moment().add(7, 'days').subtract(5, 'seconds'), moment().add(7, 'days'))).toBe(true);
      });

      let p_docExpectation = p_doc.then(function(doc) {
        // test document inserted into database
        expect(doc).toBeDefined();
        expect(doc.user).toBe(user);
        expect(doc.token).toMatch(/^[a-zA-Z0-9_-]{32}$/gm);
        expect(doc.status).toBe(model.TOKEN_STATUS_VALID);
        expect(moment(doc.issueTime).isValid()).toBe(true);
        expect(doc.creationReason).toBe('test creation');
        expect(moment(doc.expiryTime).isValid()).toBe(true);
        expect(moment(doc.expiryTime)
          .isBetween(moment().add(7, 'days').subtract(5, 'seconds'), moment().add(7, 'days'))).toBe(true);
      });

      Promise.all([p_countExpectation, p_docExpectation, p_insertTest])
      .then(done, done.fail);
    });

    it('rejects with invalid parameters', function(done) {
      let ps = [];

      ps.push(model.createToken().then(function() {
        return Promise.reject('Unexpectedly created token but user is not defined');
      }, function (reason) {
        expect(reason).toMatch(/createToken: user is not defined/i);
      }));

      ps.push(model.createToken(1).then(function() {
        return Promise.reject('Unexpectedly created token but user is not a string');
      }, function (reason) {
        expect(reason).toMatch(/createToken: user must be a string/i);
      }));

      ps.push(model.createToken('user').then(function() {
        return Promise.reject('Unexpectedly created token but justification is not defined');
      }, function (reason) {
        expect(reason).toMatch(/createToken: justification is not defined/i);
      }));

      ps.push(model.createToken('user', 1).then(function() {
        return Promise.reject('Unexpectedly created token but justification is not a string');
      }, function (reason) {
        expect(reason).toMatch(/createToken: justification must be a string/i);
      }));

      Promise.all(ps).then(done, done.fail);
    });
  });


  describe('revokeToken', function() {

    it('succeeds on existing token', function(done) {
      let user = 'user@example.com';
      let token = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

      let p_collection = p_db.then(getCollection('tokens'));

      let p_insertion = p_collection.then(function(collection) {
        return collection.insertOne({
          user, token, status: model.TOKEN_STATUS_VALID
        });
      });

      let p_revoke = p_insertion.then(function() {
        return model.revokeToken(user, token, 'Test revocation');
      });

      let p_cursor = p_revoke.then(function() {
        return p_collection.then(function(collection) {
          return collection.find({token});
        });
      });

      let p_doc = p_cursor.then(function(cursor) {
        return cursor.next();
      });

      p_doc.then(function(doc) {
        expect(doc).toBeDefined();
        expect(doc.user).toBe(user);
        expect(doc.token).toBe(token);
        expect(doc.status).toBe(model.TOKEN_STATUS_REVOKED);
      }).then(done, done.fail);
    });

    it('rejects with invalid parameters', function(done) {
      let ps = [];

      ps.push(model.revokeToken().then(function() {
        return Promise.reject('Unexpectedly revoked token but user is not defined');
      }, function (reason) {
        expect(reason).toMatch(/revokeToken: user is not defined/i);
      }));

      ps.push(model.revokeToken(1).then(function() {
        return Promise.reject('Unexpectedly revoked token but user is not a string');
      }, function (reason) {
        expect(reason).toMatch(/revokeToken: user must be a string/i);
      }));

      ps.push(model.revokeToken('user').then(function() {
        return Promise.reject('Unexpectedly revoked token but token is not defined');
      }, function (reason) {
        expect(reason).toMatch(/revokeToken: token is not defined/i);
      }));

      ps.push(model.revokeToken('user', 1).then(function() {
        return Promise.reject('Unexpectedly revoked token but token is not a string');
      }, function (reason) {
        expect(reason).toMatch(/revokeToken: token must be a string/i);
      }));

      ps.push(model.revokeToken('user', 'token').then(function() {
        return Promise.reject('Unexpectedly revoked token but justification is not defined');
      }, function (reason) {
        expect(reason).toMatch(/revokeToken: justification is not defined/i);
      }));

      ps.push (model.revokeToken('user', 'token', 1).then(function() {
        return Promise.reject('Unexpectedly revoked token but justification is not a string');
      }, function (reason) {
        expect(reason).toMatch(/revokeToken: justification must be a string/i);
      }));

      Promise.all(ps).then(done, done.fail);
    });

    it('fails when users do not match', function(done) {
      let creatingUser = 'user@example.com';
      let revokingUser = 'bad@example.com';
      let token = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

      let p_collection = p_db.then(getCollection('tokens'));

      let p_insertion = p_collection.then(function(collection) {
        return collection.insertOne({
          creatingUser, token, status: model.TOKEN_STATUS_VALID
        });
      });

      let p_revoke = p_insertion.then(function() {
        return model.revokeToken(revokingUser, token, 'Test revocation');
      });

      p_revoke.then(function() {
        fail('Unexpectedly revoked token but users do not match');
      }, function(reason) {
        expect(reason.message).toEqual(model.ERROR_USER_NOT_TOKEN_OWNER);
      }).then(done, done.fail);
    });

    it('fails when token does not exist', function(done) {
      let user = 'user@example.com';
      let token = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

      let p_collection = p_db.then(getCollection('tokens'));

      let p_revoke = p_collection.then(function() {
        return model.revokeToken(user, token, 'Test revocation');
      });

      p_revoke.then(function() {
        fail('Unexpectedly revoked token but token should not exist');
      }, function(reason) {
        expect(reason instanceof model.DbError).toBe(true);
        expect(reason.message).toBe(
          model.ERROR_UNEXPECTED_NUM_DOCS
        );
      }).then(done, done.fail);
    });
  });


  describe('listTokens', function() {

    it('succeeds', function(done) {
      let user = 'user@example.com';
      let token1 = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
      let token2 = 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

      let p_collection = p_db.then(getCollection('tokens'));

      let p_insertion1 = p_collection.then(function(collection) {
        return collection.insertOne({
          user, token: token1, status: model.TOKEN_STATUS_VALID
        });
      });

      let p_insertion2 = p_collection.then(function(collection) {
        return collection.insertOne({
          user, token: token2, status: model.TOKEN_STATUS_VALID
        });
      });

      let p_tokens = Promise.all([p_insertion1, p_insertion2]).then(function() {
        return model.listTokens(user);
      });

      p_tokens.then(function(tokens) {
        expect(tokens instanceof Array).toBe(true);
        let tokenVals = tokens.map(function(row) {
          return row.token;
        });
        expect(tokenVals).toContain(token1);
        expect(tokenVals).toContain(token2);
        let tokenUsers = tokens.every(function(row) {
          return row.user === user;
        });
        expect(tokenUsers).toBe(true);
        let tokensValid = tokens.every(function(row) {
          return row.status === model.TOKEN_STATUS_VALID;
        });
        expect(tokensValid).toBe(true);
      }).then(done, done.fail);
    });

    it('succeeds despite no tokens', function(done) {
      let user = 'user@example.com';

      let p_collection = p_db.then(getCollection('tokens'));

      let p_noTokens = p_collection.then(function() {
        return model.listTokens(user);
      });

      p_noTokens.then(function(tokens) {
        expect(tokens instanceof Array).toBe(true);
        expect(tokens.length).toBe(0);
      }).then(done, done.fail);
    });

    it('rejects with invalid parameters', function(done) {
      let ps = [];

      ps.push(model.listTokens().then(function() {
        return Promise.reject('Unexpectedly listed tokens but user is not defined');
      }, function (reason) {
        expect(reason).toMatch(/listTokens: user is not defined/i);
      }));

      ps.push(model.listTokens(1).then(function() {
        return Promise.reject('Unexpectedly listed tokens but user is not a string');
      }, function (reason) {
        expect(reason).toMatch(/listTokens: user must be a string/i);
      }));

      Promise.all(ps).then(done, done.fail);
    });
  });


  describe('checkToken', function() {

    it('succeeds', function(done) {
      let user = 'user@example.com';
      let token = 'DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD';
      let reqdGroups = ['1', '5'];

      let p_tokenCollection = p_db.then(getCollection('tokens'));

      let p_tokenInsertion = p_tokenCollection.then(function(collection) {
        return collection.insertOne({
          user, token, status: model.TOKEN_STATUS_VALID
        });
      });

      let p_userCollection = p_db.then(getCollection('users'));

      let p_userInsertion = p_userCollection.then(function(collection) {
        return collection.insertOne({user, groups: ['1', '2', '5']});
      });

      let p_result =
        Promise.all([p_tokenInsertion, p_userInsertion])
        .then(function() {
          return model.checkToken(reqdGroups, token);
        });

      p_result.then(function(result) {
        expect(result).toBe(true);
        done();
      }, done.fail);
    });

    it('successfully returns false', function(done) {
      let user = 'user@example.com';
      let token = 'DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD';
      let reqdGroups = ['1', '5'];

      let p_tokenCollection = p_db.then(getCollection('tokens'));

      let p_tokenInsertion = p_tokenCollection.then(function(collection) {
        return collection.insertOne({
          user, token, status: model.TOKEN_STATUS_VALID
        });
      });

      let p_userCollection = p_db.then(getCollection('users'));

      let p_userInsertion = p_userCollection.then(function(collection) {
        return collection.insertOne({user, groups: ['1', '2', '3']});
      });

      let p_result =
        Promise.all([p_tokenInsertion, p_userInsertion])
        .then(function() {
          return model.checkToken(reqdGroups, token);
        });

      p_result.then(function(result) {
        expect(result).toBe(false);
        done();
      }, done.fail);
    });

    it('rejects with invalid parameters', function(done) {
      let ps = [];

      ps.push(model.checkToken().then(function() {
        return Promise.reject('Unexpectedly checked tokens but groups is not defined');
      }, function (reason) {
        expect(reason).toMatch(/checkToken: groups is not defined/i);
      }));

      ps.push(model.checkToken(1).then(function() {
        return Promise.reject('Unexpectedly checked tokens but groups is not an Array');
      }, function (reason) {
        expect(reason).toMatch(/checkToken: groups must be an Array/i);
      }));

      ps.push(model.checkToken(['a_group']).then(function() {
        return Promise.reject('Unexpectedly checked tokens but token is not defined');
      }, function (reason) {
        expect(reason).toMatch(/checkToken: token is not defined/i);
      }));

      ps.push(model.checkToken(['a_group'], 1).then(function() {
        return Promise.reject('Unexpectedly checked tokens but is not a string');
      }, function (reason) {
        expect(reason).toMatch(/checkToken: token must be a string/i);
      }));

      Promise.all(ps).then(done, done.fail);
    });

    it('fails when token does not exist', function(done) {
      let user = 'user@example.com';
      let token = 'DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD';
      let reqdGroups = ['1', '5'];

      let p_userCollection = p_db.then(getCollection('users'));

      let p_userInsertion = p_userCollection.then(function(collection) {
        return collection.insertOne({user, groups: ['1', '2', '3']});
      });

      let p_result = p_userInsertion.then(function() {
        return model.checkToken(reqdGroups, token);
      });

      p_result.then(function() {
        fail();
      }, function(reason) {
        expect(reason instanceof model.DbError).toBe(true);
        expect(reason.message).toBe(
          model.ERROR_UNEXPECTED_NUM_DOCS
        );
      }).then(done, done.fail);
    });

    it('successfully returns false when groups field is missing',
      function(done) {
        let user = 'nogroups@example.com';
        let token = 'EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE';
        let reqdGroups = ['1', '5'];

        let p_tokenCollection = p_db.then(getCollection('tokens'));

        let p_tokenInsertion = p_tokenCollection.then(function(collection) {
          return collection.insertOne({
            user, token, status: model.TOKEN_STATUS_VALID
          });
        });

        let p_userCollection = p_db.then(getCollection('users'));

        let p_userInsertion = p_userCollection.then(function(collection) {
          return collection.insertOne({user});
        });

        let p_result = Promise.all([p_tokenInsertion, p_userInsertion])
          .then(function() {
            return model.checkToken(reqdGroups, token);
          });

        p_result.then(function(result) {
          expect(result).toBe(false);
          done();
        }, done.fail);
      });

    it('successfully returns false when groups field is empty', function(done) {
      let user = 'emptygroups@example.com';
      let token = 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF';
      let reqdGroups = ['1', '5'];

      let p_tokenCollection = p_db.then(getCollection('tokens'));

      let p_tokenInsertion = p_tokenCollection.then(function(collection) {
        return collection.insertOne({
          user, token, status: model.TOKEN_STATUS_VALID
        });
      });

      let p_userCollection = p_db.then(getCollection('users'));

      let p_userInsertion = p_userCollection.then(function(collection) {
        return collection.insertOne({user, groups: []});
      });

      let p_result = Promise.all([p_tokenInsertion, p_userInsertion])
        .then(function() {
          return model.checkToken(reqdGroups, token);
        });

      p_result.then(function(result) {
        expect(result).toBe(false);
        done();
      }, done.fail);
    });

    it('successfully returns false when token has been revoked', function(done) {
      let user = 'revoked@example.com';
      let token = 'GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG';
      let reqdGroups = ['1', '5'];

      let p_tokenCollection = p_db.then(getCollection('tokens'));

      let p_tokenInsertion = p_tokenCollection.then(function(collection) {
        return collection.insertOne({
          user, token, status: model.TOKEN_STATUS_REVOKED
        });
      });

      let p_userCollection = p_db.then(getCollection('users'));

      let p_userInsertion = p_userCollection.then(function(collection) {
        return collection.insertOne({user, groups: ['1', '2', '5']});
      });

      let p_result = Promise.all([p_tokenInsertion, p_userInsertion])
        .then(function() {
          return model.checkToken(reqdGroups, token);
        });

      p_result.then(function(result) {
        expect(result).toBe(false);
        done();
      }, done.fail);
    });

    it('successfully returns false when token has expired', function(done) {
      let user = 'revoked@example.com';
      let token = 'HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH';
      let reqdGroups = ['1', '5'];
      let expiryTime = moment(0).toISOString(); // 1 Jan 1970

      let p_tokenCollection = p_db.then(getCollection('tokens'));

      let p_tokenInsertion = p_tokenCollection.then(function(collection) {
        return collection.insertOne({
          user, token, status: model.TOKEN_STATUS_VALID, expiryTime
        });
      });

      let p_userCollection = p_db.then(getCollection('users'));

      let p_userInsertion = p_userCollection.then(function(collection) {
        return collection.insertOne({user, groups: ['1', '2', '5']});
      });

      let p_result = Promise.all([p_tokenInsertion, p_userInsertion])
        .then(function() {
          return model.checkToken(reqdGroups, token);
        });

      p_result.then(function(result) {
        expect(result).toBe(false);
        done();
      }, done.fail);
    });
  });
});
