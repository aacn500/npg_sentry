/**
 * Copyright (C) 2017 Genome Research Ltd
 * See license in LICENSE
 */

// This module uses 'p_' prefix to signify promises
// e.g., p_db is a promise that, when fulfilled,
// provides the db object.
//

'use strict';

const assert      = require('assert');
const randomBytes = require('crypto').randomBytes;

const moment      = require('moment');
const MongoClient = require('mongodb').MongoClient;

const constants = require('./constants.js');
const config    = require('./config.js');
const logger    = require('./logger.js');

const UNEXPECTED_NUM_DOCS  = constants.UNEXPECTED_NUM_DOCS;
const USER_NOT_TOKEN_OWNER = constants.USER_NOT_TOKEN_OWNER;

class DbError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DbError';
  }
}

function getCollection(collName) {
  return function(db) {
    logger.debug('Searching for collection ' + collName);
    return new Promise(function(resolve, reject) {
      db.collection(collName, function(err, collection) {
        if (err) {
          reject(err);
        } else {
          logger.debug('Found collection ' + collName);
          resolve(collection);
        }
      });
    });
  };
}

function _validate(scope, name, value, type) {
  assert(value, `${scope}: ${name} is not defined`);
  if ( type ) {
    assert(typeof value === type, `${scope}: ${name} must be a ${type}`);
  }
}

function _validateNoEmptyString(scope, name, value, type) {
  _validate(scope, name, value, type);
  assert(
    value.trim() !== '',
    `${scope}: ${name} cannot be empty string`
  );
}

// TODO check if mongo works as a pool already, probably this variables should
// not be in the whole module scope
let p_db = MongoClient.connect(config.provide().get('mongourl'));

p_db.then(function() {
  logger.debug('Successfully connected to database');
});

p_db.catch(function(reason) {
  logger.error(reason);
  throw reason;
});

let p_collection = p_db.then(getCollection(constants.COLLECTION_TOKENS));

p_collection.catch(function(reason) {
  logger.error(reason);
  throw reason;
});

function generateTokenPromise() {
  return new Promise(function(resolve, reject) {
    // TODO refactor to prevent collisions with tokens in db
    // 24 bytes will generate a 32 character base64 string
    logger.debug('Generating new token');
    randomBytes(24, function(err, buf) {
      if (err) {
        reject(err);
      }
      // http://stackoverflow.com/questions/8838624/node-js-send-email-on-
      // registration/8842959#8842959
      resolve(buf.toString('base64').replace(/\//g, '_').replace(/\+/g, '-'));
    });
  });
}

function findMatchingTokens(token) {
  return p_collection.then(function(collection) {
    logger.debug('Searching database for token: ' + token);
    let query = {token: token};
    // This will automatically reject if collection.find() throws an error.
    // No need to manually catch and reject.
    return collection.find(query);
  });
}

function getDocument(p_cursor) {
  return function() {
    return p_cursor.then(function(cursor) {
      logger.debug('Retrieving next document from cursor');
      return cursor.next();
    });
  };
}

function cursorHasExactlyOneDoc(p_cursor) {
  return p_cursor.then(function(cursor) {
    logger.debug('Checking db only found one result');
    return cursor.count();
  })
  .then(function(count) {
    return count === 1 ? Promise.resolve()
                       : Promise.reject(new DbError(UNEXPECTED_NUM_DOCS));
  });
}

function _buildToken(token, user, justification) {
  let now = moment();
  let validDuration = moment.duration(
    constants.TOKEN_DURATION, constants.TOKEN_DURATION_UNIT
  );
  return {
    token: token,
    status: constants.TOKEN_STATUS_VALID,
    hist: [{time: now.format(), reason: justification}],
    user: user,
    expiryTime: now.clone().add(validDuration).format()
  };
}

let createToken = function createToken(user, justification) {
  // TODO what if user is unknown?
  try {
    let fName = 'createToken';
    _validateNoEmptyString(fName, 'user', user, 'string');
    _validateNoEmptyString(fName, 'justification', justification, 'string');
  } catch ( e ) {
    return Promise.reject(e);
  }

  return generateTokenPromise().then(function(token) {
    let doc = _buildToken(token, user, justification);
    return p_collection.then(function(collection) {
      logger.debug('Inserting new token into database');
      return collection.insertOne(doc)
        .then(function() {
          return Promise.resolve(doc);
        });
    });
  })
  .catch(function(reason) {
    logger.error(reason);
    return Promise.reject(reason);
  });
};

function _updateToken(doc, update) {
  return p_collection.then(function(collection) {
    logger.debug('Updating token ' + doc.token +
                 '; update obj ' + JSON.stringify(update));
    return collection.findOneAndUpdate({token: doc.token}, update, {returnOriginal: false})
      .then(function(updateRes) {
        return updateRes.value;
      });
  });
}

let revokeToken = function revokeToken(user, token, justification) {
  logger.debug('Revoking ' + token + ' for user ' + user);
  try {
    let fName = 'revokeToken';
    _validateNoEmptyString(fName, 'user', user, 'string');
    _validateNoEmptyString(fName, 'token', token, 'string');
    _validateNoEmptyString(fName, 'justification', justification, 'string');
  } catch ( e ) {
    return Promise.reject(e);
  }
  let p_cursor = findMatchingTokens(token);

  // Need to be sure that there was only one instance of this token in the db
  let p_onlyOneDoc = cursorHasExactlyOneDoc(p_cursor);

  let p_document = p_onlyOneDoc.then(getDocument(p_cursor));

  // Need to be sure that the user requesting revocation is the same
  // as the one who created the token
  let p_correctUser = p_document.then(function(doc) {
    return user === doc.user ? Promise.resolve()
                             : Promise.reject(new Error(USER_NOT_TOKEN_OWNER));
  });

  let p_updated = p_correctUser.then(function() {
    return p_document.then(function(doc) {
      let update = {
        $set: {
          status: constants.TOKEN_STATUS_REVOKED
        },
        $push: {
          hist: {
            time: moment().format(),
            reason: justification
          }
        }
      };
      return _updateToken(doc, update);
    });
  });

  return p_updated;
};


let listTokens = function listTokens(user) {
  // TODO: what if user not recognised?
  logger.debug('Listing tokens for user', user);
  try {
    let functionName = 'listTokens';
    assert(user, `${functionName}: user is not defined`);
    assert(typeof user === 'string', `${functionName}: user must be a string`);
  } catch (e) {
    return Promise.reject(e);
  }

  return p_collection.then(function(collection) {
    // sort so valid tokens at top
    return collection.find({user}).sort('status', -1).toArray();
  });
};

let validateToken = function validateToken(groups, token) {
  logger.debug('Validating token ' + token + ' authorises bearer');
  try {
    let fName = 'validateToken';
    _validate(fName, 'groups', groups);
    assert(groups instanceof Array, `${fName}: groups must be an Array`);
    _validateNoEmptyString(fName, 'token', token, 'string');
  } catch ( e ) {
    return Promise.reject(e);
  }
  let p_cursor = findMatchingTokens(token);

  let p_onlyOneDoc = cursorHasExactlyOneDoc(p_cursor);

  let p_document = p_onlyOneDoc.then(getDocument(p_cursor));

  return p_document.then(function(doc) {
    if (doc.status === constants.TOKEN_STATUS_REVOKED) {
      return false;
    }
    let now = moment();
    if (doc.expiryTime && now.isAfter(doc.expiryTime)) {
      return false;
    }
    return validateUser(groups, doc.user);
  });
};

let validateUser = function validateUser(groups, user) {
  logger.debug('Validating that user ' + user + ' is member of all groups ' +
               JSON.stringify(groups));
  try {
    let fName = 'validateUser';
    _validate(fName, 'groups', groups);
    assert(groups instanceof Array, `${fName}: groups must be an Array`);
    _validateNoEmptyString(fName, 'user', user, 'string');
  } catch ( e ) {
    return Promise.reject(e);
  }

  let p_user_collection = p_db.then(getCollection(constants.COLLECTION_USERS));

  let p_user_cursor = p_user_collection.then(function(collection) {
    return collection.find({user: user});
  });

  let p_user_onlyOneDoc = cursorHasExactlyOneDoc(p_user_cursor);

  let p_user_document = p_user_onlyOneDoc.then(getDocument(p_user_cursor));

  let p_groups = p_user_document.then(function(doc) {
    return doc.groups;
  });

  return p_groups.then(function(userGroups) {
    if (!userGroups) {
      return false;
    }
    return groups.every(function(val) {
      return userGroups.indexOf(val) >= 0;
    });
  });
};

module.exports = {
  DbError,
  createToken,
  revokeToken,
  listTokens,
  validateUser,
  validateToken,
};
