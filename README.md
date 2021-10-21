# Third Call

This an incremental improvement to [secondCall](https://github.com/gherlein/secondCall). It includes a CDK script to manage all the needed AWS infrastructure and a lambda function
that does the work.

Deploying this will deliver a solution that has a single phone number. Call that number and the app will determine if that number has called before. If not, it will tell you what
number you dialed from and the time, then hang up. If it detects that you have called previously it will just tell you the time and hang up. It stores that state in DynamoDB.

Under the hood this app deploys a SIP Media Appliance (SMA), a SIP Rule, and a Phone Number. These will cost money! When you are done with this demo you can delete it all with

```
make destroy
make delete-chime
```

The "make destroy" will invoke a custom resource from chime-cdk-support. At this time it does not fully support deletion. That is why the second command is needed, that does the work using the AWS CLI.

## Incremental Improvements

I moved all the Chime and harder AWS service interfaces into a submodule "chill" to abstract away those complexities. In the future that will become a Lambda Layer. You can see more about
the Chill library [here](https://github.com/gherlein/chill/).

## Cloning to get Submodules Automatically

To get all the code for this project, clone the repo with this:

```
git clone --recurse-submodules --remote-submodules git@github.com:gherlein/thirdCall.git
```

That will pull the main repo and checkout the submodules in one step.

## Installing Dependencies

After cloning, to the following to get all the needed modules and then test your build:

```
make modules
make build
```

The "make build" will run the typescript compiler for the CDK. It does not deploy the solution.

## Usage

To deploy the solution:

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

## Other Helpers

You can get a tail on the logs with:

```
make logs
```

These update fairly slowly so be patient and wait 60 seconds if you think it's not working.

If you prefer a bit nice watch on the logs, install [saw](https://github.com/TylerBrock/saw) and then:

```
make watch
```

## Invoking just the lambda function directly without going through the SMA

You can test the functionality of the lamba directly by:

```
make invoke
```

This will use the file "test/in.json" as a sample input to the function. This is useful to ensure that your code is actually invoking properly with no javascript errors.
