# Third Call

This an incremental improvement to [secondCall](https://github.com/gherlein/secondCall).

## Incremental Improvements

I moved all the Chime and harder AWS service interfaces into a submodule "chill" to abstract away those complexities. In the future that will become a Lambda Layer.

## Cloning to get Submodiles Automatically

To get all the code for this project, clone the repo with this:

```
git clone --recurse-submodules --remote-submodules git@github.com:gherlein/thirdCall.git
```

That will pull the main repo and checkout the submodules in one step.

## Usage

This repo has a Makefile. You can:

```
make deploy
```

and it will deploy the CDK and output some variables, including a phone number. Call that number from your phone.

You can clean up everything with:

```
make destroy
```

However, the submodule "chime-cdk-support" is not yet fully supporting deletion of Chime resources. The makefule supports an extra step to delete he Phone Numbers, SIP Rules, and SMA by:

```
make delete-chime
```

##Other Helpers

You can get a tail on the logs with:

```
make logs
```

These update fairly slowly so be patient and wait 60 seconds if you think it's not working.
