"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ThirdCallStack = void 0;
//  “Copyright Amazon.com Inc. or its affiliates.” 
const cdk = require("@aws-cdk/core");
const s3 = require("@aws-cdk/aws-s3");
const iam = require("@aws-cdk/aws-iam");
const lambda = require("@aws-cdk/aws-lambda");
const custom = require("@aws-cdk/custom-resources");
const sqs = require("@aws-cdk/aws-sqs");
const ddb = require("@aws-cdk/aws-dynamodb");
class ThirdCallStack extends cdk.Stack {
    constructor(scope, id, props) {
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
                }),
            ],
        });
        const pollyPollicy = new iam.Policy(this, 'pollyPollicy', {
            document: pollyPolicyDoc
        });
        smaLambdaRole.attachInlinePolicy(pollyPollicy);
        // create the lambda function that does the call
        const thirdCall = new lambda.Function(this, 'thirdCall', {
            code: lambda.Code.fromAsset("src", { exclude: ["README.md"] }),
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
                                'lambda:AddPermission',
                                'cloudformation:DescribeStacks',
                                'cloudformation:DescribeStackEvents',
                                'cloudformation:DescribeStackResource',
                                'cloudformation:DescribeStackResources',]
                        })]
                })
            },
            managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole")]
        });
        /*
            // create the lambda for CDK custom resource to deploy SMA, etc.
            const chimeCDKsupportLambda = new lambda.Function(this, 'chimeCDKsupportLambda', {
              code: lambda.Code.fromAsset("chime-cdk-support", { exclude: ["README.md"] }),
              handler: 'chime-cdk-support.on_event',
              runtime: lambda.Runtime.PYTHON_3_9,
              role: chimeCreateRole,
              timeout: cdk.Duration.seconds(60)
            });
        */
        // create the lambda for CDK custom resource to deploy SMA, etc.
        const chimeCDKsupportLambda = new lambda.Function(this, 'chimeCDKsupportLambda', {
            code: lambda.Code.fromAsset("lambda", { exclude: ["README.md"] }),
            handler: 'index.handler',
            runtime: lambda.Runtime.NODEJS_14_X,
            role: chimeCreateRole,
            timeout: cdk.Duration.seconds(120),
        });
        const chimeProvider = new custom.Provider(this, 'chimeProvider', {
            onEventHandler: chimeCDKsupportLambda
        });
        // need type declarations
        // https://www.typescriptlang.org/docs/handbook/declaration-files/introduction.html
        const chimeProviderProperties = {
            lambdaArn: thirdCall.functionArn,
            region: this.region,
            smaName: this.stackName,
            sipRuleName: this.stackName,
            sipTriggerType: '',
            createSMA: true,
            phoneNumberRequired: true,
            phoneAreaCode: '505',
            phoneState: '',
            phoneCountry: '',
            phoneNumberType: 'SipMediaApplicationDialIn',
            phoneNumberTollFreePrefix: '',
        };
        console.log(chimeProviderProperties);
        console.log(chimeProvider.serviceToken);
        const inboundSMA = new cdk.CustomResource(this, 'inboundSMA', {
            serviceToken: chimeProvider.serviceToken,
            properties: chimeProviderProperties,
        });
        // these are the attributes returned from the custom resource!
        const inboundPhoneNumber = inboundSMA.getAttString('phoneNumber');
        const smaID = inboundSMA.getAttString("smaID");
        const sipRuleID = inboundSMA.getAttString("sipRuleID");
        const sipRuleName = inboundSMA.getAttString("sipRuleName");
        // Write the Telephony Handling Data to the output
        new cdk.CfnOutput(this, 'region', { value: this.region });
        new cdk.CfnOutput(this, 'inboundPhoneNumber', { value: inboundPhoneNumber });
        new cdk.CfnOutput(this, 'lambdaLog', { value: thirdCall.logGroup.logGroupName });
        new cdk.CfnOutput(this, 'lambdaARN', { value: thirdCall.functionArn });
        new cdk.CfnOutput(this, "smaID", { value: smaID });
        new cdk.CfnOutput(this, "sipRuleID", { value: sipRuleID });
        new cdk.CfnOutput(this, "sipRuleName", { value: sipRuleName });
        new cdk.CfnOutput(this, 'providerLog', { value: thirdCall.logGroup.logGroupName });
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
        callInfoTable.grantFullAccess(thirdCall);
        // put the table name in the lambda environment
        thirdCall.addEnvironment('CALLINFO_TABLE_NAME', callInfoTable.tableName);
        new cdk.CfnOutput(this, 'thirdCallInfoTable', { value: callInfoTable.tableName });
    }
}
exports.ThirdCallStack = ThirdCallStack;
exports.thirdCallStack = ThirdCallStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidGhpcmRfY2FsbC1zdGFjay5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInRoaXJkX2NhbGwtc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBQUEsbURBQW1EO0FBQ25ELHFDQUFxQztBQUNyQyxzQ0FBdUM7QUFFdkMsd0NBQXdDO0FBQ3hDLDhDQUErQztBQUMvQyxvREFBb0Q7QUFDcEQsd0NBQXlDO0FBR3pDLDZDQUE2QztBQUs3QyxNQUFhLGNBQWUsU0FBUSxHQUFHLENBQUMsS0FBSztJQUMzQyxZQUFZLEtBQW9CLEVBQUUsRUFBVSxFQUFFLEtBQXNCO1FBQ2xFLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBRXhCLE1BQU0sZUFBZSxHQUFHLElBQUksR0FBRyxDQUFDLEtBQUssQ0FBQyxJQUFJLEVBQUUsaUJBQWlCLENBQUMsQ0FBQztRQUUvRCx5RUFBeUU7UUFDekUsTUFBTSxRQUFRLEdBQUcsSUFBSSxFQUFFLENBQUMsTUFBTSxDQUFDLElBQUksRUFBRSxVQUFVLEVBQUU7WUFDL0MsZ0JBQWdCLEVBQUUsS0FBSztZQUN2QixhQUFhLEVBQUUsR0FBRyxDQUFDLGFBQWEsQ0FBQyxPQUFPO1lBQ3hDLGlCQUFpQixFQUFFLElBQUk7U0FDeEIsQ0FBQyxDQUFDO1FBQ0gsTUFBTSxtQkFBbUIsR0FBRyxJQUFJLEdBQUcsQ0FBQyxlQUFlLENBQUM7WUFDbEQsTUFBTSxFQUFFLEdBQUcsQ0FBQyxNQUFNLENBQUMsS0FBSztZQUN4QixPQUFPLEVBQUU7Z0JBQ1AsY0FBYztnQkFDZCxjQUFjO2dCQUNkLGlCQUFpQjthQUNsQjtZQUNELFNBQVMsRUFBRTtnQkFDVCxRQUFRLENBQUMsU0FBUztnQkFDbEIsR0FBRyxRQUFRLENBQUMsU0FBUyxJQUFJO2FBQzFCO1lBQ0QsR0FBRyxFQUFFLHlCQUF5QjtTQUMvQixDQUFDLENBQUM7UUFDSCxtQkFBbUIsQ0FBQyxtQkFBbUIsQ0FBQyxvQ0FBb0MsQ0FBQyxD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QUFDO0lBQ3BGLENBQUM7Q0FFRjtBQXBQRCx3Q0FvUEM7QUFDRCxPQUFPLENBQUMsY0FBYyxHQUFHLGNBQWMsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8vICDigJxDb3B5cmlnaHQgQW1hem9uLmNvbSBJbmMuIG9yIGl0cyBhZmZpbGlhdGVzLuKAnSBcbmltcG9ydCAqIGFzIGNkayBmcm9tICdAYXdzLWNkay9jb3JlJztcbmltcG9ydCBzMyA9IHJlcXVpcmUoJ0Bhd3MtY2RrL2F3cy1zMycpO1xuaW1wb3J0IHMzZGVwbG95ID0gcmVxdWlyZSgnQGF3cy1jZGsvYXdzLXMzLWRlcGxveW1lbnQnKVxuaW1wb3J0IGlhbSA9IHJlcXVpcmUoJ0Bhd3MtY2RrL2F3cy1pYW0nKVxuaW1wb3J0IGxhbWJkYSA9IHJlcXVpcmUoJ0Bhd3MtY2RrL2F3cy1sYW1iZGEnKTtcbmltcG9ydCBjdXN0b20gPSByZXF1aXJlKCdAYXdzLWNkay9jdXN0b20tcmVzb3VyY2VzJylcbmltcG9ydCBzcXMgPSByZXF1aXJlKCdAYXdzLWNkay9hd3Mtc3FzJyk7XG5cbmltcG9ydCAqIGFzIGFwcHN5bmMgZnJvbSAnQGF3cy1jZGsvYXdzLWFwcHN5bmMnO1xuaW1wb3J0ICogYXMgZGRiIGZyb20gJ0Bhd3MtY2RrL2F3cy1keW5hbW9kYic7XG5pbXBvcnQgeyBGcm9tQ2xvdWRGb3JtYXRpb25Qcm9wZXJ0eU9iamVjdCB9IGZyb20gJ0Bhd3MtY2RrL2NvcmUvbGliL2Nmbi1wYXJzZSc7XG5pbXBvcnQgeyBDaGltZUNsaWVudCB9IGZyb20gJ0Bhd3Mtc2RrL2NsaWVudC1jaGltZSc7XG5pbXBvcnQgeyBzdHJpbmdpZnkgfSBmcm9tICdxdWVyeXN0cmluZyc7XG5cbmV4cG9ydCBjbGFzcyBUaGlyZENhbGxTdGFjayBleHRlbmRzIGNkay5TdGFjayB7XG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBjZGsuQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wcz86IGNkay5TdGFja1Byb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkLCBwcm9wcyk7XG5cbiAgICBjb25zdCBkZWFkTGV0dGVyUXVldWUgPSBuZXcgc3FzLlF1ZXVlKHRoaXMsICdkZWFkTGV0dGVyUXVldWUnKTtcblxuICAgIC8vIGNyZWF0ZSBhIGJ1Y2tldCBmb3IgdGhlIHJlY29yZGVkIHdhdmUgZmlsZXMgYW5kIHNldCB0aGUgcmlnaHQgcG9saWNpZXNcbiAgICBjb25zdCB3YXZGaWxlcyA9IG5ldyBzMy5CdWNrZXQodGhpcywgJ3dhdkZpbGVzJywge1xuICAgICAgcHVibGljUmVhZEFjY2VzczogZmFsc2UsXG4gICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgICAgYXV0b0RlbGV0ZU9iamVjdHM6IHRydWVcbiAgICB9KTtcbiAgICBjb25zdCB3YXZGaWxlQnVja2V0UG9saWN5ID0gbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgYWN0aW9uczogW1xuICAgICAgICAnczM6R2V0T2JqZWN0JyxcbiAgICAgICAgJ3MzOlB1dE9iamVjdCcsXG4gICAgICAgICdzMzpQdXRPYmplY3RBY2wnXG4gICAgICBdLFxuICAgICAgcmVzb3VyY2VzOiBbXG4gICAgICAgIHdhdkZpbGVzLmJ1Y2tldEFybixcbiAgICAgICAgYCR7d2F2RmlsZXMuYnVja2V0QXJufS8qYFxuICAgICAgXSxcbiAgICAgIHNpZDogJ1NJUE1lZGlhQXBwbGljYXRpb25SZWFkJyxcbiAgICB9KTtcbiAgICB3YXZGaWxlQnVja2V0UG9saWN5LmFkZFNlcnZpY2VQcmluY2lwYWwoJ3ZvaWNlY29ubmVjdG9yLmNoaW1lLmFtYXpvbmF3cy5jb20nKTtcbiAgICB3YXZGaWxlcy5hZGRUb1Jlc291cmNlUG9saWN5KHdhdkZpbGVCdWNrZXRQb2xpY3kpO1xuICAgIC8qXG4gICAgICAgIG5ldyBzM2RlcGxveS5CdWNrZXREZXBsb3ltZW50KHRoaXMsICdXYXZEZXBsb3knLCB7XG4gICAgICAgICAgc291cmNlczogW3MzZGVwbG95LlNvdXJjZS5hc3NldCgnLi93YXZfZmlsZXMnKV0sXG4gICAgICAgICAgZGVzdGluYXRpb25CdWNrZXQ6IHdhdkZpbGVzLFxuICAgICAgICAgIGNvbnRlbnRUeXBlOiAnYXVkaW8vd2F2J1xuICAgICAgICB9KTtcbiAgICAqL1xuICAgIGNvbnN0IHNtYUxhbWJkYVJvbGUgPSBuZXcgaWFtLlJvbGUodGhpcywgJ3NtYUxhbWJkYVJvbGUnLCB7XG4gICAgICBhc3N1bWVkQnk6IG5ldyBpYW0uU2VydmljZVByaW5jaXBhbCgnbGFtYmRhLmFtYXpvbmF3cy5jb20nKSxcbiAgICB9KTtcbiAgICBzbWFMYW1iZGFSb2xlLmFkZE1hbmFnZWRQb2xpY3koaWFtLk1hbmFnZWRQb2xpY3kuZnJvbUF3c01hbmFnZWRQb2xpY3lOYW1lKFwic2VydmljZS1yb2xlL0FXU0xhbWJkYUJhc2ljRXhlY3V0aW9uUm9sZVwiKSk7XG5cbiAgICBjb25zdCBwb2xseVJvbGUgPSBuZXcgaWFtLlJvbGUodGhpcywgJ3BvbGx5Um9sZScsIHtcbiAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKCdsYW1iZGEuYW1hem9uYXdzLmNvbScpLFxuICAgIH0pO1xuXG4gICAgY29uc3QgcG9sbHlQb2xpY3lEb2MgPSBuZXcgaWFtLlBvbGljeURvY3VtZW50KHtcbiAgICAgIHN0YXRlbWVudHM6IFtcbiAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgICAgICAvL2FjdGlvbnM6IFtcInBvbGx5OlN0YXJ0U3BlZWNoU3ludGhlc2lzVGFza1wiLFwicG9sbHk6TGlzdFNwZWVjaFN5bnRoZXNpc1Rhc2tzXCIsXCJwb2xseTpHZXRTcGVlY2hTeW50aGVzaXNUYXNrXCJdLFxuICAgICAgICAgIGFjdGlvbnM6IFtcInBvbGx5OlN5bnRoZXNpemVTcGVlY2hcIl0sXG4gICAgICAgICAgcmVzb3VyY2VzOiBbXCIqXCJdLFxuICAgICAgICB9KSxcbiAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgICAgICBhY3Rpb25zOiBbXCJzMzpQdXRPYmplY3RcIiwgXCJzMzpMaXN0T2JqZWN0XCJdLFxuICAgICAgICAgIHJlc291cmNlczogW2Ake3dhdkZpbGVzLmJ1Y2tldEFybn0vKmBdLFxuICAgICAgICB9KSwvKlxuICAgICAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgICAgICAgICAgICBhY3Rpb25zOiBbXCJzbnM6UHVibGlzaFwiXSxcbiAgICAgICAgICAgICAgICByZXNvdXJjZXM6IFtcIipcIl0sXG4gICAgICAgICAgICB9KSwqL1xuICAgICAgXSxcbiAgICB9KTtcbiAgICBjb25zdCBwb2xseVBvbGxpY3kgPSBuZXcgaWFtLlBvbGljeSh0aGlzLCAncG9sbHlQb2xsaWN5Jywge1xuICAgICAgZG9jdW1lbnQ6IHBvbGx5UG9saWN5RG9jXG4gICAgfSk7XG4gICAgc21hTGFtYmRhUm9sZS5hdHRhY2hJbmxpbmVQb2xpY3kocG9sbHlQb2xsaWN5KTtcblxuICAgIC8vIGNyZWF0ZSB0aGUgbGFtYmRhIGZ1bmN0aW9uIHRoYXQgZG9lcyB0aGUgY2FsbFxuICAgIGNvbnN0IHRoaXJkQ2FsbCA9IG5ldyBsYW1iZGEuRnVuY3Rpb24odGhpcywgJ3RoaXJkQ2FsbCcsIHtcbiAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmZyb21Bc3NldChcInNyY1wiLCB7IGV4Y2x1ZGU6IFtcIlJFQURNRS5tZFwiXSB9KSxcbiAgICAgIGhhbmRsZXI6ICd0aGlyZENhbGwuaGFuZGxlcicsXG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5OT0RFSlNfMTRfWCxcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIFdBVkZJTEVfQlVDS0VUOiB3YXZGaWxlcy5idWNrZXROYW1lLFxuICAgICAgfSxcbiAgICAgIHJvbGU6IHNtYUxhbWJkYVJvbGUsXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcyg2MClcbiAgICB9KTtcbiAgICBjb25zdCBjaGltZUNyZWF0ZVJvbGUgPSBuZXcgaWFtLlJvbGUodGhpcywgJ2NyZWF0ZUNoaW1lTGFtYmRhUm9sZScsIHtcbiAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKCdsYW1iZGEuYW1hem9uYXdzLmNvbScpLFxuICAgICAgaW5saW5lUG9saWNpZXM6IHtcbiAgICAgICAgWydjaGltZVBvbGljeSddOiBuZXcgaWFtLlBvbGljeURvY3VtZW50KHtcbiAgICAgICAgICBzdGF0ZW1lbnRzOiBbbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgICAgcmVzb3VyY2VzOiBbJyonXSxcbiAgICAgICAgICAgIGFjdGlvbnM6IFsnY2hpbWU6KicsXG4gICAgICAgICAgICAgICdsYW1iZGE6R2V0UG9saWN5JyxcbiAgICAgICAgICAgICAgJ2xhbWJkYTpBZGRQZXJtaXNzaW9uJyxcbiAgICAgICAgICAgICAgJ2Nsb3VkZm9ybWF0aW9uOkRlc2NyaWJlU3RhY2tzJyxcbiAgICAgICAgICAgICAgJ2Nsb3VkZm9ybWF0aW9uOkRlc2NyaWJlU3RhY2tFdmVudHMnLFxuICAgICAgICAgICAgICAnY2xvdWRmb3JtYXRpb246RGVzY3JpYmVTdGFja1Jlc291cmNlJyxcbiAgICAgICAgICAgICAgJ2Nsb3VkZm9ybWF0aW9uOkRlc2NyaWJlU3RhY2tSZXNvdXJjZXMnLF1cbiAgICAgICAgICB9KV1cbiAgICAgICAgfSlcbiAgICAgIH0sXG4gICAgICBtYW5hZ2VkUG9saWNpZXM6IFtpYW0uTWFuYWdlZFBvbGljeS5mcm9tQXdzTWFuYWdlZFBvbGljeU5hbWUoXCJzZXJ2aWNlLXJvbGUvQVdTTGFtYmRhQmFzaWNFeGVjdXRpb25Sb2xlXCIpXVxuICAgIH0pO1xuXG4gICAgLypcbiAgICAgICAgLy8gY3JlYXRlIHRoZSBsYW1iZGEgZm9yIENESyBjdXN0b20gcmVzb3VyY2UgdG8gZGVwbG95IFNNQSwgZXRjLlxuICAgICAgICBjb25zdCBjaGltZUNES3N1cHBvcnRMYW1iZGEgPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsICdjaGltZUNES3N1cHBvcnRMYW1iZGEnLCB7XG4gICAgICAgICAgY29kZTogbGFtYmRhLkNvZGUuZnJvbUFzc2V0KFwiY2hpbWUtY2RrLXN1cHBvcnRcIiwgeyBleGNsdWRlOiBbXCJSRUFETUUubWRcIl0gfSksXG4gICAgICAgICAgaGFuZGxlcjogJ2NoaW1lLWNkay1zdXBwb3J0Lm9uX2V2ZW50JyxcbiAgICAgICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5QWVRIT05fM185LFxuICAgICAgICAgIHJvbGU6IGNoaW1lQ3JlYXRlUm9sZSxcbiAgICAgICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcyg2MClcbiAgICAgICAgfSk7XG4gICAgKi9cblxuICAgIC8vIGNyZWF0ZSB0aGUgbGFtYmRhIGZvciBDREsgY3VzdG9tIHJlc291cmNlIHRvIGRlcGxveSBTTUEsIGV0Yy5cbiAgICBjb25zdCBjaGltZUNES3N1cHBvcnRMYW1iZGEgPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsICdjaGltZUNES3N1cHBvcnRMYW1iZGEnLCB7XG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5mcm9tQXNzZXQoXCJsYW1iZGFcIiwgeyBleGNsdWRlOiBbXCJSRUFETUUubWRcIl0gfSksXG4gICAgICBoYW5kbGVyOiAnaW5kZXguaGFuZGxlcicsXG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5OT0RFSlNfMTRfWCxcbiAgICAgIHJvbGU6IGNoaW1lQ3JlYXRlUm9sZSxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDEyMCksXG4gICAgfSk7XG5cbiAgICBjb25zdCBjaGltZVByb3ZpZGVyID0gbmV3IGN1c3RvbS5Qcm92aWRlcih0aGlzLCAnY2hpbWVQcm92aWRlcicsIHtcbiAgICAgIG9uRXZlbnRIYW5kbGVyOiBjaGltZUNES3N1cHBvcnRMYW1iZGFcbiAgICB9KTtcblxuICAgIC8vIG5lZWQgdHlwZSBkZWNsYXJhdGlvbnNcbiAgICAvLyBodHRwczovL3d3dy50eXBlc2NyaXB0bGFuZy5vcmcvZG9jcy9oYW5kYm9vay9kZWNsYXJhdGlvbi1maWxlcy9pbnRyb2R1Y3Rpb24uaHRtbFxuICAgIGNvbnN0IGNoaW1lUHJvdmlkZXJQcm9wZXJ0aWVzID0ge1xuICAgICAgbGFtYmRhQXJuOiB0aGlyZENhbGwuZnVuY3Rpb25Bcm4sXG4gICAgICByZWdpb246IHRoaXMucmVnaW9uLFxuICAgICAgc21hTmFtZTogdGhpcy5zdGFja05hbWUsXG4gICAgICBzaXBSdWxlTmFtZTogdGhpcy5zdGFja05hbWUsXG4gICAgICBzaXBUcmlnZ2VyVHlwZTogJydcbiAgICAgIGNyZWF0ZVNNQTogdHJ1ZSxcbiAgICAgIHBob25lTnVtYmVyUmVxdWlyZWQ6IHRydWUsXG4gICAgICBwaG9uZUFyZWFDb2RlOiAnNTA1JyxcbiAgICAgIHBob25lU3RhdGU6ICcnLFxuICAgICAgcGhvbmVDb3VudHJ5OiAnJyxcbiAgICAgIHBob25lTnVtYmVyVHlwZTogJ1NpcE1lZGlhQXBwbGljYXRpb25EaWFsSW4nLCAvLyBCdXNpbmVzc0NhbGxpbmcgfCBWb2ljZUNvbm5lY3RvciB8IFNpcE1lZGlhQXBwbGljYXRpb25EaWFsSW5cbiAgICAgIHBob25lTnVtYmVyVG9sbEZyZWVQcmVmaXg6ICcnLFxuICAgIH1cbiAgICBjb25zb2xlLmxvZyhjaGltZVByb3ZpZGVyUHJvcGVydGllcyk7XG4gICAgY29uc29sZS5sb2coY2hpbWVQcm92aWRlci5zZXJ2aWNlVG9rZW4pO1xuXG4gICAgY29uc3QgaW5ib3VuZFNNQSA9IG5ldyBjZGsuQ3VzdG9tUmVzb3VyY2UodGhpcywgJ2luYm91bmRTTUEnLCB7XG4gICAgICBzZXJ2aWNlVG9rZW46IGNoaW1lUHJvdmlkZXIuc2VydmljZVRva2VuLFxuICAgICAgcHJvcGVydGllczogY2hpbWVQcm92aWRlclByb3BlcnRpZXMsXG4gICAgfSk7XG5cbiAgICAvLyB0aGVzZSBhcmUgdGhlIGF0dHJpYnV0ZXMgcmV0dXJuZWQgZnJvbSB0aGUgY3VzdG9tIHJlc291cmNlIVxuICAgIGNvbnN0IGluYm91bmRQaG9uZU51bWJlciA9IGluYm91bmRTTUEuZ2V0QXR0U3RyaW5nKCdwaG9uZU51bWJlcicpO1xuICAgIGNvbnN0IHNtYUlEID0gaW5ib3VuZFNNQS5nZXRBdHRTdHJpbmcoXCJzbWFJRFwiKTtcbiAgICBjb25zdCBzaXBSdWxlSUQgPSBpbmJvdW5kU01BLmdldEF0dFN0cmluZyhcInNpcFJ1bGVJRFwiKTtcbiAgICBjb25zdCBzaXBSdWxlTmFtZSA9IGluYm91bmRTTUEuZ2V0QXR0U3RyaW5nKFwic2lwUnVsZU5hbWVcIik7XG5cbiAgICAvLyBXcml0ZSB0aGUgVGVsZXBob255IEhhbmRsaW5nIERhdGEgdG8gdGhlIG91dHB1dFxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdyZWdpb24nLCB7IHZhbHVlOiB0aGlzLnJlZ2lvbiB9KTtcbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnaW5ib3VuZFBob25lTnVtYmVyJywgeyB2YWx1ZTogaW5ib3VuZFBob25lTnVtYmVyIH0pO1xuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdsYW1iZGFMb2cnLCB7IHZhbHVlOiB0aGlyZENhbGwubG9nR3JvdXAubG9nR3JvdXBOYW1lIH0pO1xuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdsYW1iZGFBUk4nLCB7IHZhbHVlOiB0aGlyZENhbGwuZnVuY3Rpb25Bcm4gfSk7XG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgXCJzbWFJRFwiLCB7IHZhbHVlOiBzbWFJRCB9KTtcbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCBcInNpcFJ1bGVJRFwiLCB7IHZhbHVlOiBzaXBSdWxlSUQgfSk7XG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgXCJzaXBSdWxlTmFtZVwiLCB7IHZhbHVlOiBzaXBSdWxlTmFtZSB9KTtcbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAncHJvdmlkZXJMb2cnLCB7IHZhbHVlOiB0aGlyZENhbGwubG9nR3JvdXAubG9nR3JvdXBOYW1lIH0pO1xuXG4gICAgLypcbiAgICAgICAgLy8gQ3JlYXRlIEFwcFN5bmMgYW5kIGRhdGFiYXNlXG4gICAgICAgIGNvbnN0IGFwaSA9IG5ldyBhcHBzeW5jLkdyYXBocWxBcGkodGhpcywgJ0FwaScsIHtcbiAgICAgICAgICBuYW1lOiAnY2RrLW5vdGVzLWFwcHN5bmMtYXBpJyxcbiAgICAgICAgICBzY2hlbWE6IGFwcHN5bmMuU2NoZW1hLmZyb21Bc3NldCgnZ3JhcGhxbC9zY2hlbWEuZ3JhcGhxbCcpLFxuICAgICAgICAgIGF1dGhvcml6YXRpb25Db25maWc6IHtcbiAgICAgICAgICAgIGRlZmF1bHRBdXRob3JpemF0aW9uOiB7XG4gICAgICAgICAgICAgIGF1dGhvcml6YXRpb25UeXBlOiBhcHBzeW5jLkF1dGhvcml6YXRpb25UeXBlLkFQSV9LRVksXG4gICAgICAgICAgICAgIGFwaUtleUNvbmZpZzoge1xuICAgICAgICAgICAgICAgIGV4cGlyZXM6IGNkay5FeHBpcmF0aW9uLmFmdGVyKGNkay5EdXJhdGlvbi5kYXlzKDM2NSkpXG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgICB4cmF5RW5hYmxlZDogdHJ1ZSxcbiAgICAgICAgfSk7XG4gICAgXG4gICAgXG4gICAgICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsIFwiR3JhcGhRTEFQSVVSTFwiLCB7IHZhbHVlOiBhcGkuZ3JhcGhxbFVybCB9KTtcbiAgICAgICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgXCJHcmFwaFFMQVBJS2V5XCIsIHsgdmFsdWU6IGFwaS5hcGlLZXkgfHwgJycgfSk7XG4gICAgICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsIFwiU3RhY2tSZWdpb25cIiwgIHsgdmFsdWU6IHRoaXMucmVnaW9uIH0pO1xuICAgIFxuICAgICAgICBcbiAgICAgICAgY29uc3Qgbm90ZXNMYW1iZGEgPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsICdBcHBTeW5jTm90ZXNIYW5kbGVyJywge1xuICAgICAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLk5PREVKU18xMl9YLFxuICAgICAgICAgIGhhbmRsZXI6ICdtYWluLmhhbmRsZXInLFxuICAgICAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmZyb21Bc3NldCgnbGFtYmRhLWZucycpLFxuICAgICAgICAgIG1lbW9yeVNpemU6IDEwMjRcbiAgICAgICAgfSk7XG4gICAgICAgIFxuICAgICAgICAvLyBzZXQgdGhlIG5ldyBMYW1iZGEgZnVuY3Rpb24gYXMgYSBkYXRhIHNvdXJjZSBmb3IgdGhlIEFwcFN5bmMgQVBJXG4gICAgICAgIGNvbnN0IGxhbWJkYURzID0gYXBpLmFkZExhbWJkYURhdGFTb3VyY2UoJ2xhbWJkYURhdGFzb3VyY2UnLCBub3Rlc0xhbWJkYSk7XG4gICAgXG4gICAgXG4gICAgICAgIC8vIHNldCB0aGUgQ2FsbEhhbmRsZXIgZnVuY3Rpb24gYXMgdGhlIGRhdGEgc291cmNlIGZvciBBcHBTeW5jIEFQSVxuICAgICAgICBjb25zdCBsYW1iZGFEcyA9IGFwaS5hZGRMYW1iZGFEYXRhU291cmNlKCd0aGlyZENhbGwnLCB0aGlyZENhbGwpO1xuICAgIFxuICAgIFxuICAgICAgICAvLyBjcmVhdGUgcmVzb2x2ZXJzIHRvIG1hdGNoIEdyYXBoUUwgb3BlcmF0aW9ucyBpbiBzY2hlbWFcbiAgICAgICAgbGFtYmRhRHMuY3JlYXRlUmVzb2x2ZXIoe1xuICAgICAgICAgIHR5cGVOYW1lOiBcIlF1ZXJ5XCIsXG4gICAgICAgICAgZmllbGROYW1lOiBcImdldE5vdGVCeUlkXCJcbiAgICAgICAgfSk7XG4gICAgXG4gICAgICAgIGxhbWJkYURzLmNyZWF0ZVJlc29sdmVyKHtcbiAgICAgICAgICB0eXBlTmFtZTogXCJRdWVyeVwiLFxuICAgICAgICAgIGZpZWxkTmFtZTogXCJsaXN0Tm90ZXNcIlxuICAgICAgICB9KTtcbiAgICBcbiAgICAgICAgbGFtYmRhRHMuY3JlYXRlUmVzb2x2ZXIoe1xuICAgICAgICAgIHR5cGVOYW1lOiBcIk11dGF0aW9uXCIsXG4gICAgICAgICAgZmllbGROYW1lOiBcImNyZWF0ZU5vdGVcIlxuICAgICAgICB9KTtcbiAgICBcbiAgICAgICAgbGFtYmRhRHMuY3JlYXRlUmVzb2x2ZXIoe1xuICAgICAgICAgIHR5cGVOYW1lOiBcIk11dGF0aW9uXCIsXG4gICAgICAgICAgZmllbGROYW1lOiBcImRlbGV0ZU5vdGVcIlxuICAgICAgICB9KTtcbiAgICBcbiAgICAgICAgbGFtYmRhRHMuY3JlYXRlUmVzb2x2ZXIoe1xuICAgICAgICAgIHR5cGVOYW1lOiBcIk11dGF0aW9uXCIsXG4gICAgICAgICAgZmllbGROYW1lOiBcInVwZGF0ZU5vdGVcIlxuICAgICAgICB9KTtcbiAgICAqL1xuXG4gICAgY29uc3QgY2FsbEluZm9UYWJsZSA9IG5ldyBkZGIuVGFibGUodGhpcywgJ2NhbGxJbmZvJywge1xuICAgICAgcGFydGl0aW9uS2V5OiB7XG4gICAgICAgIG5hbWU6ICdwaG9uZU51bWJlcicsXG4gICAgICAgIHR5cGU6IGRkYi5BdHRyaWJ1dGVUeXBlLlNUUklOR1xuICAgICAgfSxcbiAgICAgIHJlbW92YWxQb2xpY3k6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgICBiaWxsaW5nTW9kZTogZGRiLkJpbGxpbmdNb2RlLlBBWV9QRVJfUkVRVUVTVCxcbiAgICAgIHN0cmVhbTogZGRiLlN0cmVhbVZpZXdUeXBlLk5FV19JTUFHRVxuICAgIH0pO1xuXG4gICAgLy8gZW5hYmxlIHRoZSBMYW1iZGEgZnVuY3Rpb24gdG8gYWNjZXNzIHRoZSBEeW5hbW9EQiB0YWJsZSAodXNpbmcgSUFNKVxuICAgIGNhbGxJbmZvVGFibGUuZ3JhbnRGdWxsQWNjZXNzKHRoaXJkQ2FsbClcbiAgICAvLyBwdXQgdGhlIHRhYmxlIG5hbWUgaW4gdGhlIGxhbWJkYSBlbnZpcm9ubWVudFxuICAgIHRoaXJkQ2FsbC5hZGRFbnZpcm9ubWVudCgnQ0FMTElORk9fVEFCTEVfTkFNRScsIGNhbGxJbmZvVGFibGUudGFibGVOYW1lKTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICd0aGlyZENhbGxJbmZvVGFibGUnLCB7IHZhbHVlOiBjYWxsSW5mb1RhYmxlLnRhYmxlTmFtZSB9KTtcbiAgfVxuXG59XG5leHBvcnRzLnRoaXJkQ2FsbFN0YWNrID0gVGhpcmRDYWxsU3RhY2s7XG5cbiJdfQ==