//  “Copyright Amazon.com Inc. or its affiliates.”

//const numberToWords = require('number-to-words');

const chill = require('../chill/chill.js');
const { ToWords } = require('to-words');

const toWords = new ToWords({
  localeCode: 'en-US',
  converterOptions: {
    currency: false,
    ignoreDecimal: true,
    ignoreZeroCurrency: true,
    doNotAddOnly: false,
  }
});


exports.handler = async (event: CloudFormation, context, callback) => {
  console.log(JSON.stringify(event));
  let actions;

  switch (event.InvocationEventType) {
    case "NEW_INBOUND_CALL":
      //            console.log("NEW_INBOUND_CALL");
      actions = await newCall(event);
      break;

    case "ACTION_SUCCESSFUL":
      //            console.log("SUCCESS ACTION");
      actions = [hangupAction];
      break;

    case "HANGUP":
      //            console.log("HANGUP ACTION");
      actions = [];
      break;

    case "CALL_ANSWERED":
      //            console.log("CALL ANSWERED")
      actions = [];
      break;

    default:
      //            console.log("FAILED ACTION");
      actions = [hangupAction];
  }

  const response = {
    SchemaVersion: "1.0",
    Actions: actions,
  };

  callback(null, response);
};

async function newCall(event) {
  console.log({ event });
  const from = event.CallDetails.Participants[0].From;
  const callid = event.CallDetails.Participants[0].CallId;
  const start = event.CallDetails.Participants[0].StartTimeInMilliseconds;
  const keybase = "welcome.wav"

  console.log(from, callid, start);

  if (!from) {
    console.log("failed to parse from number");
    return [hangupAction];
  }

  const callInfo = await chill.getCaller(from);
  console.log({ callInfo });


  d = new Date();
  h = d.getHours();
  m = d.getMinutes();
  console.log(h.toString() + m.toString());
  phrase = "nothing";
  key = callid.toString() + "-" + keybase;

  hour = toWords.convert(h);
  minute = toWords.convert(m);
  fromnum = from.split("");
  fromstring = "";
  fromnum.forEach(element => { console.log(element) });

  if (callInfo.phoneNumber) {
    phrase = "<speak>Welcome back!<break/>The time is " + hour + minute + " U C T<break/>.  Goodbye!</speak>";
  } else {
    phrase = "<speak>Welcome.  You are calling from ";
    fromnum.forEach(element => { n = element.toString(); phrase += `${n} ` });
    phrase += "<break/>The time is " + hour + minute + " U C T<break/>.  Goodbye!</speak>";
    console.log(event.CallDetails.Participants)
    chill.putCaller(from, callid, start);
  }
  console.log("phrase is " + phrase);
  await chill.synthesizeWelcomeSpeech(phrase, key);

  /*
  const s3obj =await chill.getS3Data(chill.wavFileBucket, key);
  console.log(s3obj);
  */

  playAudioAction.Parameters.AudioSource.Key = key;

  console.log("calling playAudioAction");
  console.log(playAudioAction);
  return [playAudioAction];
}

const hangupAction = {
  Type: "Hangup",
  Parameters: {
    SipResponseCode: "0",
    ParticipantTag: "",
  },
};

const playAudioAction = {
  Type: "PlayAudio",
  Parameters: {
    AudioSource: {
      Type: "S3",
      BucketName: chill.wavFileBucket,
      Key: "",
    },
  },
};

const pauseAction = {
  Type: "Pause",
  Parameters: {
    DurationInMilliseconds: "1000",
  },
};

