//  “Copyright Amazon.com Inc. or its affiliates.” 
import * as cdk from '@aws-cdk/core';
import s3 = require('@aws-cdk/aws-s3');
import s3deploy = require('@aws-cdk/aws-s3-deployment')
import iam = require('@aws-cdk/aws-iam')
import lambda = require('@aws-cdk/aws-lambda');
import custom = require('@aws-cdk/custom-resources')
import sqs = require('@aws-cdk/aws-sqs');

import * as appsync from '@aws-cdk/aws-appsync';
import * as ddb from '@aws-cdk/aws-dynamodb';

export class ThirdCallStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const deadLetterQueue = new sqs.Queue(this, 'deadLetterQueue');

    // create a bucket for the recorded wave files and set the right policies
    const wavFiles = new s3.Bucket(this, 'wavFiles', {
      publicReadAccess: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true
    });
    const wavFileBucketPolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        's3:GetObject',
        's3:PutObject',
        's3:PutObjectAcl'
      ],
      resources: [
        wavFiles.bucketArn,
        `${wavFiles.bucketArn}/*`
      ],
      sid: 'SIPMediaApplicationRead',
    });
    wavFileBucketPolicy.addServicePrincipal('voiceconnector.chime.amazonaws.com');
    wavFiles.addToResourcePolicy(wavFileBucketPolicy);

    /*
    new s3deploy.BucketDeployment(this, 'WavDeploy', {
      sources: [s3deploy.Source.asset('./wav_files')],
      destinationBucket: wavFiles,
      contentType: 'audio/wav'
    });
    */
    const smaLambdaRole = new iam.Role(this, 'smaLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    smaLambdaRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"));

    const pollyRole = new iam.Role(this, 'pollyRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    const pollyPolicyDoc = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          //actions: ["polly:StartSpeechSynthesisTask","polly:ListSpeechSynthesisTasks","polly:GetSpeechSynthesisTask"],
          actions: ["polly:SynthesizeSpeech"],
          resources: ["*"],
        }),
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["s3:PutObject", "s3:ListObject"],
          resources: [`${wavFiles.bucketArn}/*`],
        }),/*
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ["sns:Publish"],
                resources: ["*"],
            }),*/
      ],
    });
    const pollyPollicy = new iam.Policy(this, 'pollyPollicy', {
      document: pollyPolicyDoc
    });
    smaLambdaRole.attachInlinePolicy(pollyPollicy);

    // create the lambda function that does the call
    const thirdCall = new lambda.Function(this, 'thirdCall', {
      code: lambda.Code.fromAsset("src", { exclude: ["createChimeResources.py"] }),
      handler: 'thirdCall.handler',
      runtime: lambda.Runtime.NODEJS_14_X,
      environment: {
        WAVFILE_BUCKET: wavFiles.bucketName,
      },
      role: smaLambdaRole,
      timeout: cdk.Duration.seconds(60)
    });
    const chimeCreateRole = new iam.Role(this, 'createChimeLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        ['chimePolicy']: new iam.PolicyDocument({
          statements: [new iam.PolicyStatement({
            resources: ['*'],
            actions: ['chime:*',
              'lambda:GetPolicy',
              'lambda:AddPermission']
          })]
        })
      },
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole")]
    });


    // create the lambda for CDK custom resource to deploy SMA, etc.
    const createSMALambda = new lambda.Function(this, 'createSMALambda', {
      code: lambda.Code.fromAsset("src", { exclude: ["**", "!createChimeResources.py"] }),
      handler: 'createChimeResources.on_event',
      runtime: lambda.Runtime.PYTHON_3_8,
      role: chimeCreateRole,
      timeout: cdk.Duration.seconds(60)
    });
    const chimeProvider = new custom.Provider(this, 'chimeProvider', {
      onEventHandler: createSMALambda
    });
    const inboundSMA = new cdk.CustomResource(this, 'inboundSMA', {
      serviceToken: chimeProvider.serviceToken,
      properties: {
        'lambdaArn': thirdCall.functionArn,
        'region': this.region,
        'smaName': this.stackName + '-inbound',
        'ruleName': this.stackName + '-inbound',
        'createSMA': true,
        'smaID': '',
        'phoneNumberRequired': true
      }
    });
    const inboundPhoneNumber = inboundSMA.getAttString('phoneNumber');

    // Write the Telephony Handling Data to the output
    new cdk.CfnOutput(this, 'inboundPhoneNumber', { value: inboundPhoneNumber });
    new cdk.CfnOutput(this, 'thirdCallLambdaLog', { value: thirdCall.logGroup.logGroupName });
    new cdk.CfnOutput(this, 'thirdCallLambdaARN', { value: thirdCall.functionArn });


    /*
        // Create AppSync and database
        const api = new appsync.GraphqlApi(this, 'Api', {
          name: 'cdk-notes-appsync-api',
          schema: appsync.Schema.fromAsset('graphql/schema.graphql'),
          authorizationConfig: {
            defaultAuthorization: {
              authorizationType: appsync.AuthorizationType.API_KEY,
              apiKeyConfig: {
                expires: cdk.Expiration.after(cdk.Duration.days(365))
              }
            },
          },
          xrayEnabled: true,
        });
    
    
        new cdk.CfnOutput(this, "GraphQLAPIURL", { value: api.graphqlUrl });
        new cdk.CfnOutput(this, "GraphQLAPIKey", { value: api.apiKey || '' });
        new cdk.CfnOutput(this, "StackRegion",  { value: this.region });
    
        
        const notesLambda = new lambda.Function(this, 'AppSyncNotesHandler', {
          runtime: lambda.Runtime.NODEJS_12_X,
          handler: 'main.handler',
          code: lambda.Code.fromAsset('lambda-fns'),
          memorySize: 1024
        });
        
        // set the new Lambda function as a data source for the AppSync API
        const lambdaDs = api.addLambdaDataSource('lambdaDatasource', notesLambda);
    
    
        // set the CallHandler function as the data source for AppSync API
        const lambdaDs = api.addLambdaDataSource('thirdCall', thirdCall);
    
    
        // create resolvers to match GraphQL operations in schema
        lambdaDs.createResolver({
          typeName: "Query",
          fieldName: "getNoteById"
        });
    
        lambdaDs.createResolver({
          typeName: "Query",
          fieldName: "listNotes"
        });
    
        lambdaDs.createResolver({
          typeName: "Mutation",
          fieldName: "createNote"
        });
    
        lambdaDs.createResolver({
          typeName: "Mutation",
          fieldName: "deleteNote"
        });
    
        lambdaDs.createResolver({
          typeName: "Mutation",
          fieldName: "updateNote"
        });
    */

    const callInfoTable = new ddb.Table(this, 'callInfo', {
      partitionKey: {
        name: 'phoneNumber',
        type: ddb.AttributeType.STRING
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
      stream: ddb.StreamViewType.NEW_IMAGE
    });

    // enable the Lambda function to access the DynamoDB table (using IAM)
    callInfoTable.grantFullAccess(thirdCall)
    // put the table name in the lambda environment
    thirdCall.addEnvironment('CALLINFO_TABLE_NAME', callInfoTable.tableName);

    new cdk.CfnOutput(this, 'thirdCallInfoTable', { value: callInfoTable.tableName });
  }

}
exports.thirdCallStack = ThirdCallStack;

