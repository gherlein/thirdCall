//  “Copyright Amazon.com Inc. or its affiliates.”

const REGION = process.env.REGION;
const wavFileBucket = process.env["WAVFILE_BUCKET"];
const callInfoTable = process.env["CALLINFO_TABLE_NAME"];

const AWS = require("aws-sdk");
const s3 = new AWS.S3();
const polly = new AWS.Polly({ signatureVersion: "v4", region: REGION, });
const tc = new AWS.TranscribeService({ signatureVersion: "v4", region: REGION, });

var documentClient = new AWS.DynamoDB.DocumentClient();


async function synthesizeWelcomeSpeech(phrase, s3Key) {
  console.log(phrase);
  console.log(s3Key);
  let audioBuffer = await synthesizeSpeechInternal(phrase, 'ssml', 'Joanna', 'en-US');
  if (audioBuffer) {
    audioBuffer2 = await addWaveHeaderAndUploadToS3(audioBuffer, wavFileBucket, s3Key);
  } else {
    return null;
  }
  if (audioBuffer2) {
    return audioBuffer2;
  } else {
    return null;
  }
};

async function putCaller(phoneNumber, id, startTime) {
  var params = {
    TableName: callInfoTable,
    Item: {
      phoneNumber: phoneNumber,
      id: id,
      startTime: startTime,
    },
  };

  try {
    const results = await documentClient.put(params).promise();
    console.log(results);
    return results;
  } catch (err) {
    console.log(err);
    return err;
  }
}

async function getCaller(phonenumber) {
  console.log("getCaller: " + phonenumber);
  var params = {
    TableName: callInfoTable,
    Key: { phoneNumber: phonenumber },
  };

  console.log(params);
  try {
    const results = await documentClient.get(params).promise();
    console.log(results);
    if (results) {
      const callInfo = {
        phoneNumber: results.Item.phoneNumber,
        startTime: results.Item.startTime,
        id: results.Item.id,
      };
      console.log({ callInfo });
      return callInfo;
    } else {
      console.log("phone number not found");
      return false;
    }
  } catch (err) {
    console.log(err);
    console.log("No phone found");
    return false;
  }
}

async function getS3Data(s3Bucket, s3Key) {
  let s3params = {
    Bucket: s3Bucket,
    Key: s3Key
  };

  let s3Object = await s3.getObject(s3params).promise();
  console.log("S3 Object");
  console.log(s3Object);
  return s3Object.Body;
}

module.exports = {
  synthesizeWelcomeSpeech,
  getCaller,
  putCaller,
  getS3Data,
  REGION,
  AWS,
  s3,
  polly,
  wavFileBucket,
  tc,
}

// internal functions

async function synthesizeSpeechInternal(text, textType, voiceID, languageCode) {
  try {
    let pollyparams = {
      'Text': text,
      'TextType': textType,
      'OutputFormat': 'pcm',
      'SampleRate': '8000',
      'VoiceId': voiceID,
      'LanguageCode': languageCode
    };

    const pollyResult = await polly.synthesizeSpeech(pollyparams).promise();
    if (pollyResult.AudioStream.buffer) {
      return pollyResult.AudioStream.buffer;
    }
    else {
      return null;
    }
  } catch (synthesizeError) {
    console.log(synthesizeError);
    return null;
  }
};


/*
async function synthesizeSpeech(s3Bucket, s3Key, text, textType, voiceID, languageCode) {
  let audioBuffer = await synthesizeSpeechInternal(text, textType, voiceID, languageCode);
  return audioBuffer ? addWaveHeaderAndUploadToS3(audioBuffer, s3Bucket, s3Key) : null;
};
*/

async function addWaveHeaderAndUploadToS3(audioBuffer, s3Bucket, s3Key) {
  var uint16Buffer = new Uint16Array(audioBuffer);

  var wavArray = buildWaveHeader({
    numFrames: uint16Buffer.length,
    numChannels: 1,
    sampleRate: 8000,
    bytesPerSample: 2
  });

  var totalBuffer = _appendBuffer(wavArray, audioBuffer);
  return await uploadAnnouncementToS3(s3Bucket, s3Key, totalBuffer);
};

async function uploadAnnouncementToS3(s3Bucket, s3Key, totalBuffer) {
  var buff = Buffer.from(totalBuffer);

  let s3params = {
    Body: buff,
    Bucket: s3Bucket,
    Key: s3Key,
    ContentType: 'audio/wav'
  };

  return s3.upload(s3params).promise();
};




function buildWaveHeader(opts) {
  var numFrames = opts.numFrames;
  var numChannels = opts.numChannels || 2;
  var sampleRate = opts.sampleRate || 44100;
  var bytesPerSample = opts.bytesPerSample || 2;
  var blockAlign = numChannels * bytesPerSample;
  var byteRate = sampleRate * blockAlign;
  var dataSize = numFrames * blockAlign;

  var buffer = new ArrayBuffer(44);
  var dv = new DataView(buffer);

  var p = 0;

  function writeString(s) {
    for (var i = 0; i < s.length; i++) {
      dv.setUint8(p + i, s.charCodeAt(i));
    }
    p += s.length;
  }

  function writeUint32(d) {
    dv.setUint32(p, d, true);
    p += 4;
  }

  function writeUint16(d) {
    dv.setUint16(p, d, true);
    p += 2;
  }

  writeString('RIFF');              // ChunkID
  writeUint32(dataSize + 36);       // ChunkSize
  writeString('WAVE');              // Format
  writeString('fmt ');              // Subchunk1ID
  writeUint32(16);                  // Subchunk1Size
  writeUint16(1);                   // AudioFormat
  writeUint16(numChannels);         // NumChannels
  writeUint32(sampleRate);          // SampleRate
  writeUint32(byteRate);            // ByteRate
  writeUint16(blockAlign);          // BlockAlign
  writeUint16(bytesPerSample * 8);  // BitsPerSample
  writeString('data');              // Subchunk2ID
  writeUint32(dataSize);            // Subchunk2Size

  return buffer;
}

var _appendBuffer = function (buffer1, buffer2) {
  var tmp = new Uint8Array(buffer1.byteLength + buffer2.byteLength);
  tmp.set(new Uint8Array(buffer1), 0);
  tmp.set(new Uint8Array(buffer2), buffer1.byteLength);
  return tmp;
};


