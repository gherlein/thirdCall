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
            const chimeProviderLamba = new lambda.Function(this, 'chimeProviderLamba', {
              code: lambda.Code.fromAsset("chime-cdk-support", { exclude: ["README.md"] }),
              handler: 'chime-cdk-support.on_event',
              runtime: lambda.Runtime.PYTHON_3_9,
              role: chimeCreateRole,
              timeout: cdk.Duration.seconds(60)
            });
        */
        // create the lambda for CDK custom resource to deploy SMA, etc.
        const chimeProviderLamba = new lambda.Function(this, 'chimeProviderLamba', {
            code: lambda.Code.fromAsset("../test", { exclude: ["README.md"] }),
            handler: 'index.handler',
            runtime: lambda.Runtime.NODEJS_14_X,
            role: chimeCreateRole,
            timeout: cdk.Duration.seconds(120),
        });
        const chimeProvider = new custom.Provider(this, 'chimeProvider', {
            onEventHandler: chimeProviderLamba,
        });
        // need type declarations
        // https://www.typescriptlang.org/docs/handbook/declaration-files/introduction.html
        const chimeProviderProperties = {
            lambdaArn: thirdCall.functionArn,
            region: this.region,
            smaName: this.stackName,
            sipRuleName: this.stackName,
            sipTriggerType: 'ToPhoneNumber',
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
        const phoneID = inboundSMA.getAttString("phoneID");
        // Write the Telephony Handling Data to the output
        new cdk.CfnOutput(this, 'region', {
            value: this.region,
            exportName: 'region',
        });
        new cdk.CfnOutput(this, 'inboundPhoneNumber', {
            value: inboundPhoneNumber,
            exportName: 'inboundPhoneNumber',
        });
        new cdk.CfnOutput(this, 'lambdaLog', {
            value: thirdCall.logGroup.logGroupName,
            exportName: 'lambdaLog',
        });
        new cdk.CfnOutput(this, 'lambdaARN', {
            value: thirdCall.functionArn,
            exportName: 'lambdaARN'
        });
        new cdk.CfnOutput(this, 'chimeProviderLog', {
            value: chimeProviderLamba.logGroup.logGroupName,
            exportName: 'chimeProviderLog'
        });
        new cdk.CfnOutput(this, "smaID", {
            value: smaID,
            exportName: 'smaID',
        });
        new cdk.CfnOutput(this, "phoneID", {
            value: phoneID,
            exportName: 'phoneID'
        });
        new cdk.CfnOutput(this, "sipRuleID", {
            value: sipRuleID,
            exportName: 'sipRuleID',
        });
        new cdk.CfnOutput(this, "sipRuleName", {
            value: chimeProviderProperties.sipRuleName,
            exportName: 'sipRuleName',
        });
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidGhpcmRfY2FsbC1zdGFjay5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInRoaXJkX2NhbGwtc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBQUEsbURBQW1EO0FBQ25ELHFDQUFxQztBQUNyQyxzQ0FBdUM7QUFFdkMsd0NBQXdDO0FBQ3hDLDhDQUErQztBQUMvQyxvREFBb0Q7QUFDcEQsd0NBQXlDO0FBR3pDLDZDQUE2QztBQUs3QyxNQUFhLGNBQWUsU0FBUSxHQUFHLENBQUMsS0FBSztJQUMzQyxZQUFZLEtBQW9CLEVBQUUsRUFBVSxFQUFFLEtBQXNCO1FBQ2xFLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBRXhCLE1BQU0sZUFBZSxHQUFHLElBQUksR0FBRyxDQUFDLEtBQUssQ0FBQyxJQUFJLEVBQUUsaUJBQWlCLENBQUMsQ0FBQztRQUUvRCx5RUFBeUU7UUFDekUsTUFBTSxRQUFRLEdBQUcsSUFBSSxFQUFFLENBQUMsTUFBTSxDQUFDLElBQUksRUFBRSxVQUFVLEVBQUU7WUFDL0MsZ0JBQWdCLEVBQUUsS0FBSztZQUN2QixhQUFhLEVBQUUsR0FBRyxDQUFDLGFBQWEsQ0FBQyxPQUFPO1lBQ3hDLGlCQUFpQixFQUFFLElBQUk7U0FDeEIsQ0FBQyxDQUFDO1FBQ0gsTUFBTSxtQkFBbUIsR0FBRyxJQUFJLEdBQUcsQ0FBQyxlQUFlLENBQUM7WUFDbEQsTUFBTSxFQUFFLEdBQUcsQ0FBQyxNQUFNLENBQUMsS0FBSztZQUN4QixPQUFPLEVBQUU7Z0JBQ1AsY0FBYztnQkFDZCxjQUFjO2dCQUNkLGlCQUFpQjthQUNsQjtZQUNELFNBQVMsRUFBRTtnQkFDVCxRQUFRLENBQUMsU0FBUztnQkFDbEIsR0FBRyxRQUFRLENBQUMsU0FBUyxJQUFJO2FBQzFCO1lBQ0QsR0FBRyxFQUFFLHlCQUF5QjtTQUMvQixDQUFDLENBQUM7UUFDSCxtQkFBbUIsQ0FBQyxtQkFBbUIsQ0FBQyxvQ0FBb0MsQ0FBQyxD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ZTtZQUM1QyxNQUFNLEVBQUUsR0FBRyxDQUFDLGNBQWMsQ0FBQyxTQUFTO1NBQ3JDLENBQUMsQ0FBQztRQUVILHNFQUFzRTtRQUN0RSxhQUFhLENBQUMsZUFBZSxDQUFDLFNBQVMsQ0FBQyxDQUFBO1FBQ3hDLCtDQUErQztRQUMvQyxTQUFTLENBQUMsY0FBYyxDQUFDLHFCQUFxQixFQUFFLGFBQWEsQ0FBQyxTQUFTLENBQUMsQ0FBQztRQUV6RSxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLG9CQUFvQixFQUFFLEVBQUUsS0FBSyxFQUFFLGFBQWEsQ0FBQyxTQUFTLEVBQUUsQ0FBQyxDQUFDO0lBQ3BGLENBQUM7Q0FFRjtBQS9RRCx3Q0ErUUM7QUFDRCxPQUFPLENBQUMsY0FBYyxHQUFHLGNBQWMsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8vICDigJxDb3B5cmlnaHQgQW1hem9uLmNvbSBJbmMuIG9yIGl0cyBhZmZpbGlhdGVzLuKAnSBcbmltcG9ydCAqIGFzIGNkayBmcm9tICdAYXdzLWNkay9jb3JlJztcbmltcG9ydCBzMyA9IHJlcXVpcmUoJ0Bhd3MtY2RrL2F3cy1zMycpO1xuaW1wb3J0IHMzZGVwbG95ID0gcmVxdWlyZSgnQGF3cy1jZGsvYXdzLXMzLWRlcGxveW1lbnQnKVxuaW1wb3J0IGlhbSA9IHJlcXVpcmUoJ0Bhd3MtY2RrL2F3cy1pYW0nKVxuaW1wb3J0IGxhbWJkYSA9IHJlcXVpcmUoJ0Bhd3MtY2RrL2F3cy1sYW1iZGEnKTtcbmltcG9ydCBjdXN0b20gPSByZXF1aXJlKCdAYXdzLWNkay9jdXN0b20tcmVzb3VyY2VzJylcbmltcG9ydCBzcXMgPSByZXF1aXJlKCdAYXdzLWNkay9hd3Mtc3FzJyk7XG5cbmltcG9ydCAqIGFzIGFwcHN5bmMgZnJvbSAnQGF3cy1jZGsvYXdzLWFwcHN5bmMnO1xuaW1wb3J0ICogYXMgZGRiIGZyb20gJ0Bhd3MtY2RrL2F3cy1keW5hbW9kYic7XG5pbXBvcnQgeyBGcm9tQ2xvdWRGb3JtYXRpb25Qcm9wZXJ0eU9iamVjdCB9IGZyb20gJ0Bhd3MtY2RrL2NvcmUvbGliL2Nmbi1wYXJzZSc7XG5pbXBvcnQgeyBDaGltZUNsaWVudCB9IGZyb20gJ0Bhd3Mtc2RrL2NsaWVudC1jaGltZSc7XG5pbXBvcnQgeyBzdHJpbmdpZnkgfSBmcm9tICdxdWVyeXN0cmluZyc7XG5cbmV4cG9ydCBjbGFzcyBUaGlyZENhbGxTdGFjayBleHRlbmRzIGNkay5TdGFjayB7XG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBjZGsuQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wcz86IGNkay5TdGFja1Byb3BzKSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkLCBwcm9wcyk7XG5cbiAgICBjb25zdCBkZWFkTGV0dGVyUXVldWUgPSBuZXcgc3FzLlF1ZXVlKHRoaXMsICdkZWFkTGV0dGVyUXVldWUnKTtcblxuICAgIC8vIGNyZWF0ZSBhIGJ1Y2tldCBmb3IgdGhlIHJlY29yZGVkIHdhdmUgZmlsZXMgYW5kIHNldCB0aGUgcmlnaHQgcG9saWNpZXNcbiAgICBjb25zdCB3YXZGaWxlcyA9IG5ldyBzMy5CdWNrZXQodGhpcywgJ3dhdkZpbGVzJywge1xuICAgICAgcHVibGljUmVhZEFjY2VzczogZmFsc2UsXG4gICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgICAgYXV0b0RlbGV0ZU9iamVjdHM6IHRydWVcbiAgICB9KTtcbiAgICBjb25zdCB3YXZGaWxlQnVja2V0UG9saWN5ID0gbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgYWN0aW9uczogW1xuICAgICAgICAnczM6R2V0T2JqZWN0JyxcbiAgICAgICAgJ3MzOlB1dE9iamVjdCcsXG4gICAgICAgICdzMzpQdXRPYmplY3RBY2wnXG4gICAgICBdLFxuICAgICAgcmVzb3VyY2VzOiBbXG4gICAgICAgIHdhdkZpbGVzLmJ1Y2tldEFybixcbiAgICAgICAgYCR7d2F2RmlsZXMuYnVja2V0QXJufS8qYFxuICAgICAgXSxcbiAgICAgIHNpZDogJ1NJUE1lZGlhQXBwbGljYXRpb25SZWFkJyxcbiAgICB9KTtcbiAgICB3YXZGaWxlQnVja2V0UG9saWN5LmFkZFNlcnZpY2VQcmluY2lwYWwoJ3ZvaWNlY29ubmVjdG9yLmNoaW1lLmFtYXpvbmF3cy5jb20nKTtcbiAgICB3YXZGaWxlcy5hZGRUb1Jlc291cmNlUG9saWN5KHdhdkZpbGVCdWNrZXRQb2xpY3kpO1xuICAgIC8qXG4gICAgICAgIG5ldyBzM2RlcGxveS5CdWNrZXREZXBsb3ltZW50KHRoaXMsICdXYXZEZXBsb3knLCB7XG4gICAgICAgICAgc291cmNlczogW3MzZGVwbG95LlNvdXJjZS5hc3NldCgnLi93YXZfZmlsZXMnKV0sXG4gICAgICAgICAgZGVzdGluYXRpb25CdWNrZXQ6IHdhdkZpbGVzLFxuICAgICAgICAgIGNvbnRlbnRUeXBlOiAnYXVkaW8vd2F2J1xuICAgICAgICB9KTtcbiAgICAqL1xuICAgIGNvbnN0IHNtYUxhbWJkYVJvbGUgPSBuZXcgaWFtLlJvbGUodGhpcywgJ3NtYUxhbWJkYVJvbGUnLCB7XG4gICAgICBhc3N1bWVkQnk6IG5ldyBpYW0uU2VydmljZVByaW5jaXBhbCgnbGFtYmRhLmFtYXpvbmF3cy5jb20nKSxcbiAgICB9KTtcbiAgICBzbWFMYW1iZGFSb2xlLmFkZE1hbmFnZWRQb2xpY3koaWFtLk1hbmFnZWRQb2xpY3kuZnJvbUF3c01hbmFnZWRQb2xpY3lOYW1lKFwic2VydmljZS1yb2xlL0FXU0xhbWJkYUJhc2ljRXhlY3V0aW9uUm9sZVwiKSk7XG5cbiAgICBjb25zdCBwb2xseVJvbGUgPSBuZXcgaWFtLlJvbGUodGhpcywgJ3BvbGx5Um9sZScsIHtcbiAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKCdsYW1iZGEuYW1hem9uYXdzLmNvbScpLFxuICAgIH0pO1xuXG4gICAgY29uc3QgcG9sbHlQb2xpY3lEb2MgPSBuZXcgaWFtLlBvbGljeURvY3VtZW50KHtcbiAgICAgIHN0YXRlbWVudHM6IFtcbiAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgICAgICAvL2FjdGlvbnM6IFtcInBvbGx5OlN0YXJ0U3BlZWNoU3ludGhlc2lzVGFza1wiLFwicG9sbHk6TGlzdFNwZWVjaFN5bnRoZXNpc1Rhc2tzXCIsXCJwb2xseTpHZXRTcGVlY2hTeW50aGVzaXNUYXNrXCJdLFxuICAgICAgICAgIGFjdGlvbnM6IFtcInBvbGx5OlN5bnRoZXNpemVTcGVlY2hcIl0sXG4gICAgICAgICAgcmVzb3VyY2VzOiBbXCIqXCJdLFxuICAgICAgICB9KSxcbiAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgICAgICBhY3Rpb25zOiBbXCJzMzpQdXRPYmplY3RcIiwgXCJzMzpMaXN0T2JqZWN0XCJdLFxuICAgICAgICAgIHJlc291cmNlczogW2Ake3dhdkZpbGVzLmJ1Y2tldEFybn0vKmBdLFxuICAgICAgICB9KSwvKlxuICAgICAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgICAgICAgICAgICBhY3Rpb25zOiBbXCJzbnM6UHVibGlzaFwiXSxcbiAgICAgICAgICAgICAgICByZXNvdXJjZXM6IFtcIipcIl0sXG4gICAgICAgICAgICB9KSwqL1xuICAgICAgXSxcbiAgICB9KTtcbiAgICBjb25zdCBwb2xseVBvbGxpY3kgPSBuZXcgaWFtLlBvbGljeSh0aGlzLCAncG9sbHlQb2xsaWN5Jywge1xuICAgICAgZG9jdW1lbnQ6IHBvbGx5UG9saWN5RG9jXG4gICAgfSk7XG4gICAgc21hTGFtYmRhUm9sZS5hdHRhY2hJbmxpbmVQb2xpY3kocG9sbHlQb2xsaWN5KTtcblxuICAgIC8vIGNyZWF0ZSB0aGUgbGFtYmRhIGZ1bmN0aW9uIHRoYXQgZG9lcyB0aGUgY2FsbFxuICAgIGNvbnN0IHRoaXJkQ2FsbCA9IG5ldyBsYW1iZGEuRnVuY3Rpb24odGhpcywgJ3RoaXJkQ2FsbCcsIHtcbiAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmZyb21Bc3NldChcInNyY1wiLCB7IGV4Y2x1ZGU6IFtcIlJFQURNRS5tZFwiXSB9KSxcbiAgICAgIGhhbmRsZXI6ICd0aGlyZENhbGwuaGFuZGxlcicsXG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5OT0RFSlNfMTRfWCxcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIFdBVkZJTEVfQlVDS0VUOiB3YXZGaWxlcy5idWNrZXROYW1lLFxuICAgICAgfSxcbiAgICAgIHJvbGU6IHNtYUxhbWJkYVJvbGUsXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcyg2MClcbiAgICB9KTtcbiAgICBjb25zdCBjaGltZUNyZWF0ZVJvbGUgPSBuZXcgaWFtLlJvbGUodGhpcywgJ2NyZWF0ZUNoaW1lTGFtYmRhUm9sZScsIHtcbiAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKCdsYW1iZGEuYW1hem9uYXdzLmNvbScpLFxuICAgICAgaW5saW5lUG9saWNpZXM6IHtcbiAgICAgICAgWydjaGltZVBvbGljeSddOiBuZXcgaWFtLlBvbGljeURvY3VtZW50KHtcbiAgICAgICAgICBzdGF0ZW1lbnRzOiBbbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgICAgcmVzb3VyY2VzOiBbJyonXSxcbiAgICAgICAgICAgIGFjdGlvbnM6IFsnY2hpbWU6KicsXG4gICAgICAgICAgICAgICdsYW1iZGE6R2V0UG9saWN5JyxcbiAgICAgICAgICAgICAgJ2xhbWJkYTpBZGRQZXJtaXNzaW9uJyxcbiAgICAgICAgICAgICAgJ2Nsb3VkZm9ybWF0aW9uOkRlc2NyaWJlU3RhY2tzJyxcbiAgICAgICAgICAgICAgJ2Nsb3VkZm9ybWF0aW9uOkRlc2NyaWJlU3RhY2tFdmVudHMnLFxuICAgICAgICAgICAgICAnY2xvdWRmb3JtYXRpb246RGVzY3JpYmVTdGFja1Jlc291cmNlJyxcbiAgICAgICAgICAgICAgJ2Nsb3VkZm9ybWF0aW9uOkRlc2NyaWJlU3RhY2tSZXNvdXJjZXMnLF1cbiAgICAgICAgICB9KV1cbiAgICAgICAgfSlcbiAgICAgIH0sXG4gICAgICBtYW5hZ2VkUG9saWNpZXM6IFtpYW0uTWFuYWdlZFBvbGljeS5mcm9tQXdzTWFuYWdlZFBvbGljeU5hbWUoXCJzZXJ2aWNlLXJvbGUvQVdTTGFtYmRhQmFzaWNFeGVjdXRpb25Sb2xlXCIpXVxuICAgIH0pO1xuXG4gICAgLypcbiAgICAgICAgLy8gY3JlYXRlIHRoZSBsYW1iZGEgZm9yIENESyBjdXN0b20gcmVzb3VyY2UgdG8gZGVwbG95IFNNQSwgZXRjLlxuICAgICAgICBjb25zdCBjaGltZVByb3ZpZGVyTGFtYmEgPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsICdjaGltZVByb3ZpZGVyTGFtYmEnLCB7XG4gICAgICAgICAgY29kZTogbGFtYmRhLkNvZGUuZnJvbUFzc2V0KFwiY2hpbWUtY2RrLXN1cHBvcnRcIiwgeyBleGNsdWRlOiBbXCJSRUFETUUubWRcIl0gfSksXG4gICAgICAgICAgaGFuZGxlcjogJ2NoaW1lLWNkay1zdXBwb3J0Lm9uX2V2ZW50JyxcbiAgICAgICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5QWVRIT05fM185LFxuICAgICAgICAgIHJvbGU6IGNoaW1lQ3JlYXRlUm9sZSxcbiAgICAgICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcyg2MClcbiAgICAgICAgfSk7XG4gICAgKi9cblxuICAgIC8vIGNyZWF0ZSB0aGUgbGFtYmRhIGZvciBDREsgY3VzdG9tIHJlc291cmNlIHRvIGRlcGxveSBTTUEsIGV0Yy5cbiAgICBjb25zdCBjaGltZVByb3ZpZGVyTGFtYmEgPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsICdjaGltZVByb3ZpZGVyTGFtYmEnLCB7XG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5mcm9tQXNzZXQoXCIuLi90ZXN0XCIsIHsgZXhjbHVkZTogW1wiUkVBRE1FLm1kXCJdIH0pLFxuICAgICAgaGFuZGxlcjogJ2luZGV4LmhhbmRsZXInLFxuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzE0X1gsXG4gICAgICByb2xlOiBjaGltZUNyZWF0ZVJvbGUsXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcygxMjApLFxuICAgIH0pO1xuXG4gICAgY29uc3QgY2hpbWVQcm92aWRlciA9IG5ldyBjdXN0b20uUHJvdmlkZXIodGhpcywgJ2NoaW1lUHJvdmlkZXInLCB7XG4gICAgICBvbkV2ZW50SGFuZGxlcjogY2hpbWVQcm92aWRlckxhbWJhLFxuICAgIH0pO1xuXG4gICAgLy8gbmVlZCB0eXBlIGRlY2xhcmF0aW9uc1xuICAgIC8vIGh0dHBzOi8vd3d3LnR5cGVzY3JpcHRsYW5nLm9yZy9kb2NzL2hhbmRib29rL2RlY2xhcmF0aW9uLWZpbGVzL2ludHJvZHVjdGlvbi5odG1sXG4gICAgY29uc3QgY2hpbWVQcm92aWRlclByb3BlcnRpZXMgPSB7XG4gICAgICBsYW1iZGFBcm46IHRoaXJkQ2FsbC5mdW5jdGlvbkFybixcbiAgICAgIHJlZ2lvbjogdGhpcy5yZWdpb24sXG4gICAgICBzbWFOYW1lOiB0aGlzLnN0YWNrTmFtZSxcbiAgICAgIHNpcFJ1bGVOYW1lOiB0aGlzLnN0YWNrTmFtZSxcbiAgICAgIHNpcFRyaWdnZXJUeXBlOiAnVG9QaG9uZU51bWJlcicsXG4gICAgICBwaG9uZU51bWJlclJlcXVpcmVkOiB0cnVlLFxuICAgICAgcGhvbmVBcmVhQ29kZTogJzUwNScsXG4gICAgICBwaG9uZVN0YXRlOiAnJyxcbiAgICAgIHBob25lQ291bnRyeTogJycsXG4gICAgICBwaG9uZU51bWJlclR5cGU6ICdTaXBNZWRpYUFwcGxpY2F0aW9uRGlhbEluJywgLy8gQnVzaW5lc3NDYWxsaW5nIHwgVm9pY2VDb25uZWN0b3IgfCBTaXBNZWRpYUFwcGxpY2F0aW9uRGlhbEluXG4gICAgICBwaG9uZU51bWJlclRvbGxGcmVlUHJlZml4OiAnJyxcbiAgICB9XG4gICAgY29uc29sZS5sb2coY2hpbWVQcm92aWRlclByb3BlcnRpZXMpO1xuICAgIGNvbnNvbGUubG9nKGNoaW1lUHJvdmlkZXIuc2VydmljZVRva2VuKTtcblxuICAgIGNvbnN0IGluYm91bmRTTUEgPSBuZXcgY2RrLkN1c3RvbVJlc291cmNlKHRoaXMsICdpbmJvdW5kU01BJywge1xuICAgICAgc2VydmljZVRva2VuOiBjaGltZVByb3ZpZGVyLnNlcnZpY2VUb2tlbixcbiAgICAgIHByb3BlcnRpZXM6IGNoaW1lUHJvdmlkZXJQcm9wZXJ0aWVzLFxuICAgIH0pO1xuXG4gICAgLy8gdGhlc2UgYXJlIHRoZSBhdHRyaWJ1dGVzIHJldHVybmVkIGZyb20gdGhlIGN1c3RvbSByZXNvdXJjZSFcbiAgICBjb25zdCBpbmJvdW5kUGhvbmVOdW1iZXIgPSBpbmJvdW5kU01BLmdldEF0dFN0cmluZygncGhvbmVOdW1iZXInKTtcbiAgICBjb25zdCBzbWFJRCA9IGluYm91bmRTTUEuZ2V0QXR0U3RyaW5nKFwic21hSURcIik7XG4gICAgY29uc3Qgc2lwUnVsZUlEID0gaW5ib3VuZFNNQS5nZXRBdHRTdHJpbmcoXCJzaXBSdWxlSURcIik7XG4gICAgY29uc3QgcGhvbmVJRCA9IGluYm91bmRTTUEuZ2V0QXR0U3RyaW5nKFwicGhvbmVJRFwiKTtcblxuICAgIC8vIFdyaXRlIHRoZSBUZWxlcGhvbnkgSGFuZGxpbmcgRGF0YSB0byB0aGUgb3V0cHV0XG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ3JlZ2lvbicsIHtcbiAgICAgIHZhbHVlOiB0aGlzLnJlZ2lvbixcbiAgICAgIGV4cG9ydE5hbWU6ICdyZWdpb24nLFxuICAgIH0pO1xuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdpbmJvdW5kUGhvbmVOdW1iZXInLCB7XG4gICAgICB2YWx1ZTogaW5ib3VuZFBob25lTnVtYmVyLFxuICAgICAgZXhwb3J0TmFtZTogJ2luYm91bmRQaG9uZU51bWJlcicsXG4gICAgfSk7XG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ2xhbWJkYUxvZycsIHtcbiAgICAgIHZhbHVlOiB0aGlyZENhbGwubG9nR3JvdXAubG9nR3JvdXBOYW1lLFxuICAgICAgZXhwb3J0TmFtZTogJ2xhbWJkYUxvZycsXG4gICAgfSk7XG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ2xhbWJkYUFSTicsIHtcbiAgICAgIHZhbHVlOiB0aGlyZENhbGwuZnVuY3Rpb25Bcm4sXG4gICAgICBleHBvcnROYW1lOiAnbGFtYmRhQVJOJ1xuICAgIH0pO1xuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdjaGltZVByb3ZpZGVyTG9nJywge1xuICAgICAgdmFsdWU6IGNoaW1lUHJvdmlkZXJMYW1iYS5sb2dHcm91cC5sb2dHcm91cE5hbWUsXG4gICAgICBleHBvcnROYW1lOiAnY2hpbWVQcm92aWRlckxvZydcbiAgICB9KTtcbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCBcInNtYUlEXCIsIHtcbiAgICAgIHZhbHVlOiBzbWFJRCxcbiAgICAgIGV4cG9ydE5hbWU6ICdzbWFJRCcsXG4gICAgfSk7XG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgXCJwaG9uZUlEXCIsIHtcbiAgICAgIHZhbHVlOiBwaG9uZUlELFxuICAgICAgZXhwb3J0TmFtZTogJ3Bob25lSUQnXG4gICAgfSk7XG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgXCJzaXBSdWxlSURcIiwge1xuICAgICAgdmFsdWU6IHNpcFJ1bGVJRCxcbiAgICAgIGV4cG9ydE5hbWU6ICdzaXBSdWxlSUQnLFxuICAgIH0pO1xuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsIFwic2lwUnVsZU5hbWVcIiwge1xuICAgICAgdmFsdWU6IGNoaW1lUHJvdmlkZXJQcm9wZXJ0aWVzLnNpcFJ1bGVOYW1lLFxuICAgICAgZXhwb3J0TmFtZTogJ3NpcFJ1bGVOYW1lJyxcbiAgICB9KTtcblxuICAgIC8qXG4gICAgICAgIC8vIENyZWF0ZSBBcHBTeW5jIGFuZCBkYXRhYmFzZVxuICAgICAgICBjb25zdCBhcGkgPSBuZXcgYXBwc3luYy5HcmFwaHFsQXBpKHRoaXMsICdBcGknLCB7XG4gICAgICAgICAgbmFtZTogJ2Nkay1ub3Rlcy1hcHBzeW5jLWFwaScsXG4gICAgICAgICAgc2NoZW1hOiBhcHBzeW5jLlNjaGVtYS5mcm9tQXNzZXQoJ2dyYXBocWwvc2NoZW1hLmdyYXBocWwnKSxcbiAgICAgICAgICBhdXRob3JpemF0aW9uQ29uZmlnOiB7XG4gICAgICAgICAgICBkZWZhdWx0QXV0aG9yaXphdGlvbjoge1xuICAgICAgICAgICAgICBhdXRob3JpemF0aW9uVHlwZTogYXBwc3luYy5BdXRob3JpemF0aW9uVHlwZS5BUElfS0VZLFxuICAgICAgICAgICAgICBhcGlLZXlDb25maWc6IHtcbiAgICAgICAgICAgICAgICBleHBpcmVzOiBjZGsuRXhwaXJhdGlvbi5hZnRlcihjZGsuRHVyYXRpb24uZGF5cygzNjUpKVxuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgICAgeHJheUVuYWJsZWQ6IHRydWUsXG4gICAgICAgIH0pO1xuICAgIFxuICAgIFxuICAgICAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCBcIkdyYXBoUUxBUElVUkxcIiwgeyB2YWx1ZTogYXBpLmdyYXBocWxVcmwgfSk7XG4gICAgICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsIFwiR3JhcGhRTEFQSUtleVwiLCB7IHZhbHVlOiBhcGkuYXBpS2V5IHx8ICcnIH0pO1xuICAgICAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCBcIlN0YWNrUmVnaW9uXCIsICB7IHZhbHVlOiB0aGlzLnJlZ2lvbiB9KTtcbiAgICBcbiAgICAgICAgXG4gICAgICAgIGNvbnN0IG5vdGVzTGFtYmRhID0gbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCAnQXBwU3luY05vdGVzSGFuZGxlcicsIHtcbiAgICAgICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5OT0RFSlNfMTJfWCxcbiAgICAgICAgICBoYW5kbGVyOiAnbWFpbi5oYW5kbGVyJyxcbiAgICAgICAgICBjb2RlOiBsYW1iZGEuQ29kZS5mcm9tQXNzZXQoJ2xhbWJkYS1mbnMnKSxcbiAgICAgICAgICBtZW1vcnlTaXplOiAxMDI0XG4gICAgICAgIH0pO1xuICAgICAgICBcbiAgICAgICAgLy8gc2V0IHRoZSBuZXcgTGFtYmRhIGZ1bmN0aW9uIGFzIGEgZGF0YSBzb3VyY2UgZm9yIHRoZSBBcHBTeW5jIEFQSVxuICAgICAgICBjb25zdCBsYW1iZGFEcyA9IGFwaS5hZGRMYW1iZGFEYXRhU291cmNlKCdsYW1iZGFEYXRhc291cmNlJywgbm90ZXNMYW1iZGEpO1xuICAgIFxuICAgIFxuICAgICAgICAvLyBzZXQgdGhlIENhbGxIYW5kbGVyIGZ1bmN0aW9uIGFzIHRoZSBkYXRhIHNvdXJjZSBmb3IgQXBwU3luYyBBUElcbiAgICAgICAgY29uc3QgbGFtYmRhRHMgPSBhcGkuYWRkTGFtYmRhRGF0YVNvdXJjZSgndGhpcmRDYWxsJywgdGhpcmRDYWxsKTtcbiAgICBcbiAgICBcbiAgICAgICAgLy8gY3JlYXRlIHJlc29sdmVycyB0byBtYXRjaCBHcmFwaFFMIG9wZXJhdGlvbnMgaW4gc2NoZW1hXG4gICAgICAgIGxhbWJkYURzLmNyZWF0ZVJlc29sdmVyKHtcbiAgICAgICAgICB0eXBlTmFtZTogXCJRdWVyeVwiLFxuICAgICAgICAgIGZpZWxkTmFtZTogXCJnZXROb3RlQnlJZFwiXG4gICAgICAgIH0pO1xuICAgIFxuICAgICAgICBsYW1iZGFEcy5jcmVhdGVSZXNvbHZlcih7XG4gICAgICAgICAgdHlwZU5hbWU6IFwiUXVlcnlcIixcbiAgICAgICAgICBmaWVsZE5hbWU6IFwibGlzdE5vdGVzXCJcbiAgICAgICAgfSk7XG4gICAgXG4gICAgICAgIGxhbWJkYURzLmNyZWF0ZVJlc29sdmVyKHtcbiAgICAgICAgICB0eXBlTmFtZTogXCJNdXRhdGlvblwiLFxuICAgICAgICAgIGZpZWxkTmFtZTogXCJjcmVhdGVOb3RlXCJcbiAgICAgICAgfSk7XG4gICAgXG4gICAgICAgIGxhbWJkYURzLmNyZWF0ZVJlc29sdmVyKHtcbiAgICAgICAgICB0eXBlTmFtZTogXCJNdXRhdGlvblwiLFxuICAgICAgICAgIGZpZWxkTmFtZTogXCJkZWxldGVOb3RlXCJcbiAgICAgICAgfSk7XG4gICAgXG4gICAgICAgIGxhbWJkYURzLmNyZWF0ZVJlc29sdmVyKHtcbiAgICAgICAgICB0eXBlTmFtZTogXCJNdXRhdGlvblwiLFxuICAgICAgICAgIGZpZWxkTmFtZTogXCJ1cGRhdGVOb3RlXCJcbiAgICAgICAgfSk7XG4gICAgKi9cblxuICAgIGNvbnN0IGNhbGxJbmZvVGFibGUgPSBuZXcgZGRiLlRhYmxlKHRoaXMsICdjYWxsSW5mbycsIHtcbiAgICAgIHBhcnRpdGlvbktleToge1xuICAgICAgICBuYW1lOiAncGhvbmVOdW1iZXInLFxuICAgICAgICB0eXBlOiBkZGIuQXR0cmlidXRlVHlwZS5TVFJJTkdcbiAgICAgIH0sXG4gICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgICAgYmlsbGluZ01vZGU6IGRkYi5CaWxsaW5nTW9kZS5QQVlfUEVSX1JFUVVFU1QsXG4gICAgICBzdHJlYW06IGRkYi5TdHJlYW1WaWV3VHlwZS5ORVdfSU1BR0VcbiAgICB9KTtcblxuICAgIC8vIGVuYWJsZSB0aGUgTGFtYmRhIGZ1bmN0aW9uIHRvIGFjY2VzcyB0aGUgRHluYW1vREIgdGFibGUgKHVzaW5nIElBTSlcbiAgICBjYWxsSW5mb1RhYmxlLmdyYW50RnVsbEFjY2Vzcyh0aGlyZENhbGwpXG4gICAgLy8gcHV0IHRoZSB0YWJsZSBuYW1lIGluIHRoZSBsYW1iZGEgZW52aXJvbm1lbnRcbiAgICB0aGlyZENhbGwuYWRkRW52aXJvbm1lbnQoJ0NBTExJTkZPX1RBQkxFX05BTUUnLCBjYWxsSW5mb1RhYmxlLnRhYmxlTmFtZSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAndGhpcmRDYWxsSW5mb1RhYmxlJywgeyB2YWx1ZTogY2FsbEluZm9UYWJsZS50YWJsZU5hbWUgfSk7XG4gIH1cblxufVxuZXhwb3J0cy50aGlyZENhbGxTdGFjayA9IFRoaXJkQ2FsbFN0YWNrO1xuXG4iXX0=