'use strict';

/**
 * PMS API factory.
 *
 * Returns the correct API client based on PMS_PROVIDER env variable.
 * All callers import this module so the rest of the codebase is
 * provider-agnostic.
 */

const { config } = require('../config');
const DoorLoopClient = require('./doorloop');
const BuildiumClient = require('./buildium');

function createPMSClient() {
  switch (config.pms.provider) {
    case 'buildium':
      return new BuildiumClient();
    case 'doorloop':
    default:
      return new DoorLoopClient();
  }
}

const pmsClient = createPMSClient();

module.exports = pmsClient;
