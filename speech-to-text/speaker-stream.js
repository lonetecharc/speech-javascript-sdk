/**
 * Copyright 2014 IBM Corp. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';


var Transform = require('stream').Transform;
var util = require('util');
var pullAllWith = require('lodash.pullallwith');
var noTimestamps = require('./no-timestamps');

/**
 * Object-Mode stream that splits up results by speaker.
 *
 * Output format is similar to existing results formats, but with an extra speaker field,
 *
 * Output results array will usually contain multiple results.
 * All results are interim until the final batch; the text will not change, but the speaker may, and so the text may move from one interim result to another.
 *
 * Note: when combined with a TimingStream, data events may contain a combination of final and interim results (with the last one sometimes being interim)
 *
 * Ignores interim results from the service.
 *
 * @constructor
 * @param {Object} options
 */
function SpeakerStream(options) {
  options = options || {};
  options.objectMode = true;
  Transform.call(this, options);
  /**
   * timestamps is a 2-d array.
   * The sub-array is [word, from time, to time]
   * Example:
   * [
       ["Yes", 28.92, 29.17],
       ["that's", 29.17, 29.37],
       ["right", 29.37, 29.64]
    ]
   * @type {Array<Array>}
   * @private
   */
  this.timestamps = [];
  /**
   * speaker_labels is an array of objects.
   * Example:
   * [{
      "from": 28.92,
      "to": 29.17,
      "speaker": 1,
      "confidence": 0.641,
      "final": false
    }, {
      "from": 29.17,
      "to": 29.37,
      "speaker": 1,
      "confidence": 0.641,
      "final": false
    }, {
      "from": 29.37,
      "to": 29.64,
      "speaker": 1,
      "confidence": 0.641,
      "final": false
    }]
   * @type {Array<Object>}
   * @private
   */
  this.speaker_labels = [];

}
util.inherits(SpeakerStream, Transform);

SpeakerStream.prototype.isFinal = function() {
  return this.speaker_labels.length && this.speaker_labels[this.speaker_labels.length - 1].final;
};

// positions in the timestamps 2d array
var WORD = 0;
var FROM = 1;
var TO = 2;


SpeakerStream.ERROR_MISMATCH = 'MISMATCH';


SpeakerStream.prototype.process = function() {
  var final = this.isFinal();
  var errored = false;

  // assumes that each speaker_label will have a matching word timestamp at the same index
  // stops processing and emits an error if this assumption is violated
  var pairs = this.speaker_labels.map(function(label, i) {
    var timestamp = this.timestamps[i];
    if (!timestamp || timestamp[FROM] !== label.from || timestamp[TO] !== label.to) {
      if (!errored) {
        var err = new Error('Mismatch between speaker_label and word timestamp');
        err.name = SpeakerStream.ERROR_MISMATCH;
        err.speaker_label = label;
        err.timestamp = timestamp;
        err.speaker_labels = this.speaker_labels;
        err.timestamps = this.timestamps;
        this.emit('error', err);
        errored = true;
      }
      return null;
    }
    return [timestamp, label];
  }, this);

  if (errored) {
    return;
  }

  var results = pairs.reduce(function(arr, pair) {
    // this turns our pairs into something that looks like a regular results object, only with a speaker field
    // each result represents a single "line" from a particular speaker
    // todo: consider also splitting results up at pauses (where they are split when they arrive from the service) - FormatStream helps here
    var currentResult = arr[arr.length - 1];
    if (!currentResult || currentResult.speaker !== pair[1].speaker) {
      // new speaker - start a new result
      // todo: consider trying to include word alternatives and other features in these results
      currentResult = {
        speaker: pair[1].speaker,
        alternatives: [{
          transcript: pair[0][WORD] + ' ',
          timestamps: [
            pair[0]
          ]
        }],
        final: final
      };
      // and add it to the list
      arr.push(currentResult);
    } else {
      // otherwise just append the current word to the current result
      currentResult.alternatives[0].transcript += pair[0][WORD] + ' ';
      currentResult.alternatives[0].timestamps.push(pair[0]);
    }
    return arr;
  }, []);

  if (results.length) {
    /**
     * Emit an object similar to the normal results object, only with multiple entries in the results Array (a new one
     * each time the speaker changes), and with a speaker field on the results.
     *
     * result_index is always 0 because the results always includes the entire conversation so far.
     *
     * @event SpeakerStream#data
     * @param {Object} results-format message with multiple results and an extra speaker field on each result
     */
    this.push({results: results, result_index: 0});
  }
};

/**
 * Captures the timestamps out of results or errors if timestamps are missing
 * @param {Object} data
 */
SpeakerStream.prototype.handleResults = function(data) {
  if (noTimestamps(data)) {
    var err = new Error('SpeakerStream requires that timestamps and speaker_labels be enabled');
    err.name = noTimestamps.ERROR_NO_TIMESTAMPS;
    this.emit('error', err);
    return;
  }
  data.results.filter(function(result) {
    return result.final;
  }).forEach(function(result) {
    this.timestamps = this.timestamps.concat(result.alternatives[0].timestamps);
  }, this);
};

// sorts by start time and then end time and then finality
SpeakerStream.speakerLabelsSorter = function(a, b) {
  if (a.from === b.from) {
    if (a.to === b.to) {
      return 0;
    }
    return a.to < b.to ? -1 : 1;
  }
  return a.from < b.from ? -1 : 1;
};

/**
 * Only the very last labeled word gets final: true. Up until that point, all speaker_labels are considered interim and
 * may be repeated with a new speaker selected in a later set of speaker_labels.
 *
 * @private
 * @param {Object} data
 */
SpeakerStream.prototype.handleSpeakerLabels = function(data) {
  var speaker_labels = data.speaker_labels; // eslint-disable-line camelcase

  // remove any values from the old speaker_labels that are duplicated in the new set
  pullAllWith(this.speaker_labels, speaker_labels, function(old, nw) {
    return old.from === nw.from && old.to === nw.to;
  });

  // next append the new labels to the remaining old ones
  this.speaker_labels.push.apply(this.speaker_labels, data.speaker_labels);

  // finally, ensure the list is still sorted chronologically
  this.speaker_labels.sort(SpeakerStream.speakerLabelsSorter);
};

SpeakerStream.prototype._transform = function(data, encoding, next) {
  if (Array.isArray(data.results)) {
    this.handleResults(data);
  }
  if (Array.isArray(data.speaker_labels)) {
    this.handleSpeakerLabels(data);
  }
  this.process();
  next();
};

/**
 * catches cases where speaker_labels was not enabled and internal errors that cause data loss
 *
 * @param {Function} done
 * @private
 */
SpeakerStream.prototype._flush = function(done) {
  if (this.timestamps.length !== this.speaker_labels.length) {
    var msg;
    if (this.timestamps.length && !this.speaker_labels.length) {
      msg = 'No speaker_labels found. SpeakerStream requires speaker_labels to be enabled.';
    } else {
      msg = 'Mismatch between number of word timestamps (' + this.timestamps.length + ') and number of speaker_labels (' + this.speaker_labels.length + ') - some data may be lost.';
    }
    var err = new Error(msg);
    err.name = SpeakerStream.ERROR_MISMATCH;
    err.speaker_labels = this.speaker_labels;
    err.timestamps = this.timestamps;
    this.emit('error', err);
  }
  done();
};

SpeakerStream.prototype.promise = require('./to-promise');

module.exports = SpeakerStream;