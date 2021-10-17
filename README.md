# Third Call

This is my [secondCall](https://github.com/gherlein/secondCall) application with some incremental improvements:

##Incremental Improvements

I am moving all the Chime and harder AWS service interfaces into a file chill.js to abstract that away. In the future that will become a Lambda Layer.

##Current Problems

The SMA is throwing a System Error and I'm not sure yet what I am doing wrong.

##Usage

This repo has a made file. You can:

```
make deploy
```

and it will deploy the CDK and output some variables, including a phone number. Call that number from your phone.

You can clean up everything but the Chime parts with:

```
make destroy
```

You will have to go delete the Phone Numbers, SIP Rules, and SMA yourself. Hoping to fix this in the near future.

##Other Helpers

You can get a tail on the logs with:

```
make logs
```

These update fairly slowly so be patient and wait 60 seconds if you think it's not working.
