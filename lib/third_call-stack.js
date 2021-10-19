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
        /*
            wavFiles.addToResourcePolicy(wavFileBucketPolicy);
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
        callInfoTable.grantFullAccess(thirdCall);
        // put the table name in the lambda environment
        thirdCall.addEnvironment('CALLINFO_TABLE_NAME', callInfoTable.tableName);
    }
}
exports.ThirdCallStack = ThirdCallStack;
exports.thirdCallStack = ThirdCallStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidGhpcmRfY2FsbC1zdGFjay5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInRoaXJkX2NhbGwtc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBQUEsbURBQW1EO0FBQ25ELHFDQUFxQztBQUNyQyxzQ0FBdUM7QUFFdkMsd0NBQXdDO0FBQ3hDLDhDQUErQztBQUMvQyxvREFBb0Q7QUFDcEQsd0NBQXlDO0FBR3pDLDZDQUE2QztBQUc3QyxNQUFhLGNBQWUsU0FBUSxHQUFHLENBQUMsS0FBSztJQUMzQyxZQUFZLEtBQW9CLEVBQUUsRUFBVSxFQUFFLEtBQXNCO1FBQ2xFLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBRXhCLE1BQU0sZUFBZSxHQUFHLElBQUksR0FBRyxDQUFDLEtBQUssQ0FBQyxJQUFJLEVBQUUsaUJBQWlCLENBQUMsQ0FBQztRQUUvRCx5RUFBeUU7UUFDekUsTUFBTSxRQUFRLEdBQUcsSUFBSSxFQUFFLENBQUMsTUFBTSxDQUFDLElBQUksRUFBRSxVQUFVLEVBQUU7WUFDL0MsZ0JBQWdCLEVBQUUsS0FBSztZQUN2QixhQUFhLEVBQUUsR0FBRyxDQUFDLGFBQWEsQ0FBQyxPQUFPO1lBQ3hDLGlCQUFpQixFQUFFLElBQUk7U0FDeEIsQ0FBQyxDQUFDO1FBQ0gsTUFBTSxtQkFBbUIsR0FBRyxJQUFJLEdBQUcsQ0FBQyxlQUFlLENBQUM7WUFDbEQsTUFBTSxFQUFFLEdBQUcsQ0FBQyxNQUFNLENBQUMsS0FBSztZQUN4QixPQUFPLEVBQUU7Z0JBQ1AsY0FBYztnQkFDZCxjQUFjO2dCQUNkLGlCQUFpQjthQUNsQjtZQUNELFNBQVMsRUFBRTtnQkFDVCxRQUFRLENBQUMsU0FBUztnQkFDbEIsR0FBRyxRQUFRLENBQUMsU0FBUyxJQUFJO2FBQzFCO1lBQ0QsR0FBRyxFQUFFLHlCQUF5QjtTQUMvQixDQUFDLENBQUM7UUFDSCxtQkFBbUIsQ0FBQyxtQkFBbUIsQ0FBQyxvQ0FBb0MsQ0FBQyxD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QUssRUFBRSxrQkFBa0IsRUFBRSxDQUFDLENBQUM7UUFDN0UsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxvQkFBb0IsRUFBRSxFQUFFLEtBQUssRUFBRSxTQUFTLENBQUMsUUFBUSxDQUFDLFlBQVksRUFBRSxDQUFDLENBQUM7UUFDMUYsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxvQkFBb0IsRUFBRSxFQUFFLEtBQUssRUFBRSxTQUFTLENBQUMsV0FBVyxFQUFFLENBQUMsQ0FBQztRQUdoRjs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7VUE4REU7UUFFRixNQUFNLGFBQWEsR0FBRyxJQUFJLEdBQUcsQ0FBQyxLQUFLLENBQUMsSUFBSSxFQUFFLFVBQVUsRUFBRTtZQUNwRCxZQUFZLEVBQUU7Z0JBQ1osSUFBSSxFQUFFLGFBQWE7Z0JBQ25CLElBQUksRUFBRSxHQUFHLENBQUMsYUFBYSxDQUFDLE1BQU07YUFDL0I7WUFDRCxhQUFhLEVBQUUsR0FBRyxDQUFDLGFBQWEsQ0FBQyxPQUFPO1lBQ3hDLFdBQVcsRUFBRSxHQUFHLENBQUMsV0FBVyxDQUFDLGVBQWU7WUFDNUMsTUFBTSxFQUFFLEdBQUcsQ0FBQyxjQUFjLENBQUMsU0FBUztTQUNyQyxDQUFDLENBQUM7UUFFSCxzRUFBc0U7UUFDdEUsYUFBYSxDQUFDLGVBQWUsQ0FBQyxTQUFTLENBQUMsQ0FBQTtRQUN4QywrQ0FBK0M7UUFDL0MsU0FBUyxDQUFDLGNBQWMsQ0FBQyxxQkFBcUIsRUFBRSxhQUFhLENBQUMsU0FBUyxDQUFDLENBQUM7SUFFM0UsQ0FBQztDQUVGO0FBOU1ELHdDQThNQztBQUNELE9BQU8sQ0FBQyxjQUFjLEdBQUcsY0FBYyxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLy8gIOKAnENvcHlyaWdodCBBbWF6b24uY29tIEluYy4gb3IgaXRzIGFmZmlsaWF0ZXMu4oCdIFxuaW1wb3J0ICogYXMgY2RrIGZyb20gJ0Bhd3MtY2RrL2NvcmUnO1xuaW1wb3J0IHMzID0gcmVxdWlyZSgnQGF3cy1jZGsvYXdzLXMzJyk7XG5pbXBvcnQgczNkZXBsb3kgPSByZXF1aXJlKCdAYXdzLWNkay9hd3MtczMtZGVwbG95bWVudCcpXG5pbXBvcnQgaWFtID0gcmVxdWlyZSgnQGF3cy1jZGsvYXdzLWlhbScpXG5pbXBvcnQgbGFtYmRhID0gcmVxdWlyZSgnQGF3cy1jZGsvYXdzLWxhbWJkYScpO1xuaW1wb3J0IGN1c3RvbSA9IHJlcXVpcmUoJ0Bhd3MtY2RrL2N1c3RvbS1yZXNvdXJjZXMnKVxuaW1wb3J0IHNxcyA9IHJlcXVpcmUoJ0Bhd3MtY2RrL2F3cy1zcXMnKTtcblxuaW1wb3J0ICogYXMgYXBwc3luYyBmcm9tICdAYXdzLWNkay9hd3MtYXBwc3luYyc7XG5pbXBvcnQgKiBhcyBkZGIgZnJvbSAnQGF3cy1jZGsvYXdzLWR5bmFtb2RiJztcblxuXG5leHBvcnQgY2xhc3MgVGhpcmRDYWxsU3RhY2sgZXh0ZW5kcyBjZGsuU3RhY2sge1xuICBjb25zdHJ1Y3RvcihzY29wZTogY2RrLkNvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM/OiBjZGsuU3RhY2tQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCwgcHJvcHMpO1xuXG4gICAgY29uc3QgZGVhZExldHRlclF1ZXVlID0gbmV3IHNxcy5RdWV1ZSh0aGlzLCAnZGVhZExldHRlclF1ZXVlJyk7XG5cbiAgICAvLyBjcmVhdGUgYSBidWNrZXQgZm9yIHRoZSByZWNvcmRlZCB3YXZlIGZpbGVzIGFuZCBzZXQgdGhlIHJpZ2h0IHBvbGljaWVzXG4gICAgY29uc3Qgd2F2RmlsZXMgPSBuZXcgczMuQnVja2V0KHRoaXMsICd3YXZGaWxlcycsIHtcbiAgICAgIHB1YmxpY1JlYWRBY2Nlc3M6IGZhbHNlLFxuICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcbiAgICAgIGF1dG9EZWxldGVPYmplY3RzOiB0cnVlXG4gICAgfSk7XG4gICAgY29uc3Qgd2F2RmlsZUJ1Y2tldFBvbGljeSA9IG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgJ3MzOkdldE9iamVjdCcsXG4gICAgICAgICdzMzpQdXRPYmplY3QnLFxuICAgICAgICAnczM6UHV0T2JqZWN0QWNsJ1xuICAgICAgXSxcbiAgICAgIHJlc291cmNlczogW1xuICAgICAgICB3YXZGaWxlcy5idWNrZXRBcm4sXG4gICAgICAgIGAke3dhdkZpbGVzLmJ1Y2tldEFybn0vKmBcbiAgICAgIF0sXG4gICAgICBzaWQ6ICdTSVBNZWRpYUFwcGxpY2F0aW9uUmVhZCcsXG4gICAgfSk7XG4gICAgd2F2RmlsZUJ1Y2tldFBvbGljeS5hZGRTZXJ2aWNlUHJpbmNpcGFsKCd2b2ljZWNvbm5lY3Rvci5jaGltZS5hbWF6b25hd3MuY29tJyk7XG4gICAgLypcbiAgICAgICAgd2F2RmlsZXMuYWRkVG9SZXNvdXJjZVBvbGljeSh3YXZGaWxlQnVja2V0UG9saWN5KTtcbiAgICAgICAgbmV3IHMzZGVwbG95LkJ1Y2tldERlcGxveW1lbnQodGhpcywgJ1dhdkRlcGxveScsIHtcbiAgICAgICAgICAgIHNvdXJjZXM6IFtzM2RlcGxveS5Tb3VyY2UuYXNzZXQoJy4vd2F2X2ZpbGVzJyldLFxuICAgICAgICAgICAgZGVzdGluYXRpb25CdWNrZXQ6IHdhdkZpbGVzLFxuICAgICAgICAgICAgY29udGVudFR5cGU6ICdhdWRpby93YXYnXG4gICAgICAgIH0pO1xuICAgICovXG4gICAgY29uc3Qgc21hTGFtYmRhUm9sZSA9IG5ldyBpYW0uUm9sZSh0aGlzLCAnc21hTGFtYmRhUm9sZScsIHtcbiAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKCdsYW1iZGEuYW1hem9uYXdzLmNvbScpLFxuICAgIH0pO1xuICAgIHNtYUxhbWJkYVJvbGUuYWRkTWFuYWdlZFBvbGljeShpYW0uTWFuYWdlZFBvbGljeS5mcm9tQXdzTWFuYWdlZFBvbGljeU5hbWUoXCJzZXJ2aWNlLXJvbGUvQVdTTGFtYmRhQmFzaWNFeGVjdXRpb25Sb2xlXCIpKTtcblxuICAgIGNvbnN0IHBvbGx5Um9sZSA9IG5ldyBpYW0uUm9sZSh0aGlzLCAncG9sbHlSb2xlJywge1xuICAgICAgYXNzdW1lZEJ5OiBuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoJ2xhbWJkYS5hbWF6b25hd3MuY29tJyksXG4gICAgfSk7XG4gICAgY29uc3QgcG9sbHlQb2xpY3lEb2MgPSBuZXcgaWFtLlBvbGljeURvY3VtZW50KHtcbiAgICAgIHN0YXRlbWVudHM6IFtcbiAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgICAgICAvL2FjdGlvbnM6IFtcInBvbGx5OlN0YXJ0U3BlZWNoU3ludGhlc2lzVGFza1wiLFwicG9sbHk6TGlzdFNwZWVjaFN5bnRoZXNpc1Rhc2tzXCIsXCJwb2xseTpHZXRTcGVlY2hTeW50aGVzaXNUYXNrXCJdLFxuICAgICAgICAgIGFjdGlvbnM6IFtcInBvbGx5OlN5bnRoZXNpemVTcGVlY2hcIl0sXG4gICAgICAgICAgcmVzb3VyY2VzOiBbXCIqXCJdLFxuICAgICAgICB9KSxcbiAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgICAgICBhY3Rpb25zOiBbXCJzMzpQdXRPYmplY3RcIiwgXCJzMzpMaXN0T2JqZWN0XCJdLFxuICAgICAgICAgIHJlc291cmNlczogW2Ake3dhdkZpbGVzLmJ1Y2tldEFybn0vKmBdLFxuICAgICAgICB9KSwvKlxuICAgICAgICAgICAgbmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgICAgICAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgICAgICAgICAgICBhY3Rpb25zOiBbXCJzbnM6UHVibGlzaFwiXSxcbiAgICAgICAgICAgICAgICByZXNvdXJjZXM6IFtcIipcIl0sXG4gICAgICAgICAgICB9KSwqL1xuICAgICAgXSxcbiAgICB9KTtcbiAgICBjb25zdCBwb2xseVBvbGxpY3kgPSBuZXcgaWFtLlBvbGljeSh0aGlzLCAncG9sbHlQb2xsaWN5Jywge1xuICAgICAgZG9jdW1lbnQ6IHBvbGx5UG9saWN5RG9jXG4gICAgfSk7XG4gICAgc21hTGFtYmRhUm9sZS5hdHRhY2hJbmxpbmVQb2xpY3kocG9sbHlQb2xsaWN5KTtcblxuICAgIC8vIGNyZWF0ZSB0aGUgbGFtYmRhIGZ1bmN0aW9uIHRoYXQgZG9lcyB0aGUgY2FsbFxuICAgIGNvbnN0IHRoaXJkQ2FsbCA9IG5ldyBsYW1iZGEuRnVuY3Rpb24odGhpcywgJ3RoaXJkQ2FsbCcsIHtcbiAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmZyb21Bc3NldChcInNyY1wiLCB7IGV4Y2x1ZGU6IFtcImNyZWF0ZUNoaW1lUmVzb3VyY2VzLnB5XCJdIH0pLFxuICAgICAgaGFuZGxlcjogJ3RoaXJkQ2FsbC5oYW5kbGVyJyxcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLk5PREVKU18xNF9YLFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgV0FWRklMRV9CVUNLRVQ6IHdhdkZpbGVzLmJ1Y2tldE5hbWUsXG4gICAgICB9LFxuICAgICAgcm9sZTogc21hTGFtYmRhUm9sZSxcbiAgICAgIHRpbWVvdXQ6IGNkay5EdXJhdGlvbi5zZWNvbmRzKDYwKVxuICAgIH0pO1xuICAgIGNvbnN0IGNoaW1lQ3JlYXRlUm9sZSA9IG5ldyBpYW0uUm9sZSh0aGlzLCAnY3JlYXRlQ2hpbWVMYW1iZGFSb2xlJywge1xuICAgICAgYXNzdW1lZEJ5OiBuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoJ2xhbWJkYS5hbWF6b25hd3MuY29tJyksXG4gICAgICBpbmxpbmVQb2xpY2llczoge1xuICAgICAgICBbJ2NoaW1lUG9saWN5J106IG5ldyBpYW0uUG9saWN5RG9jdW1lbnQoe1xuICAgICAgICAgIHN0YXRlbWVudHM6IFtuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICAgICAgICByZXNvdXJjZXM6IFsnKiddLFxuICAgICAgICAgICAgYWN0aW9uczogWydjaGltZToqJyxcbiAgICAgICAgICAgICAgJ2xhbWJkYTpHZXRQb2xpY3knLFxuICAgICAgICAgICAgICAnbGFtYmRhOkFkZFBlcm1pc3Npb24nXVxuICAgICAgICAgIH0pXVxuICAgICAgICB9KVxuICAgICAgfSxcbiAgICAgIG1hbmFnZWRQb2xpY2llczogW2lhbS5NYW5hZ2VkUG9saWN5LmZyb21Bd3NNYW5hZ2VkUG9saWN5TmFtZShcInNlcnZpY2Utcm9sZS9BV1NMYW1iZGFCYXNpY0V4ZWN1dGlvblJvbGVcIildXG4gICAgfSk7XG5cblxuICAgIC8vIGNyZWF0ZSB0aGUgbGFtYmRhIGZvciBDREsgY3VzdG9tIHJlc291cmNlIHRvIGRlcGxveSBTTUEsIGV0Yy5cbiAgICBjb25zdCBjcmVhdGVTTUFMYW1iZGEgPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsICdjcmVhdGVTTUFMYW1iZGEnLCB7XG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5mcm9tQXNzZXQoXCJzcmNcIiwgeyBleGNsdWRlOiBbXCIqKlwiLCBcIiFjcmVhdGVDaGltZVJlc291cmNlcy5weVwiXSB9KSxcbiAgICAgIGhhbmRsZXI6ICdjcmVhdGVDaGltZVJlc291cmNlcy5vbl9ldmVudCcsXG4gICAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5QWVRIT05fM184LFxuICAgICAgcm9sZTogY2hpbWVDcmVhdGVSb2xlLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoNjApXG4gICAgfSk7XG4gICAgY29uc3QgY2hpbWVQcm92aWRlciA9IG5ldyBjdXN0b20uUHJvdmlkZXIodGhpcywgJ2NoaW1lUHJvdmlkZXInLCB7XG4gICAgICBvbkV2ZW50SGFuZGxlcjogY3JlYXRlU01BTGFtYmRhXG4gICAgfSk7XG4gICAgY29uc3QgaW5ib3VuZFNNQSA9IG5ldyBjZGsuQ3VzdG9tUmVzb3VyY2UodGhpcywgJ2luYm91bmRTTUEnLCB7XG4gICAgICBzZXJ2aWNlVG9rZW46IGNoaW1lUHJvdmlkZXIuc2VydmljZVRva2VuLFxuICAgICAgcHJvcGVydGllczoge1xuICAgICAgICAnbGFtYmRhQXJuJzogdGhpcmRDYWxsLmZ1bmN0aW9uQXJuLFxuICAgICAgICAncmVnaW9uJzogdGhpcy5yZWdpb24sXG4gICAgICAgICdzbWFOYW1lJzogdGhpcy5zdGFja05hbWUgKyAnLWluYm91bmQnLFxuICAgICAgICAncnVsZU5hbWUnOiB0aGlzLnN0YWNrTmFtZSArICctaW5ib3VuZCcsXG4gICAgICAgICdjcmVhdGVTTUEnOiB0cnVlLFxuICAgICAgICAnc21hSUQnOiAnJyxcbiAgICAgICAgJ3Bob25lTnVtYmVyUmVxdWlyZWQnOiB0cnVlXG4gICAgICB9XG4gICAgfSk7XG4gICAgY29uc3QgaW5ib3VuZFBob25lTnVtYmVyID0gaW5ib3VuZFNNQS5nZXRBdHRTdHJpbmcoJ3Bob25lTnVtYmVyJyk7XG5cbiAgICAvLyBXcml0ZSB0aGUgVGVsZXBob255IEhhbmRsaW5nIERhdGEgdG8gdGhlIG91dHB1dFxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdpbmJvdW5kUGhvbmVOdW1iZXInLCB7IHZhbHVlOiBpbmJvdW5kUGhvbmVOdW1iZXIgfSk7XG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ3RoaXJkQ2FsbExhbWJkYUxvZycsIHsgdmFsdWU6IHRoaXJkQ2FsbC5sb2dHcm91cC5sb2dHcm91cE5hbWUgfSk7XG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ3RoaXJkQ2FsbExhbWJkYUFSTicsIHsgdmFsdWU6IHRoaXJkQ2FsbC5mdW5jdGlvbkFybiB9KTtcblxuXG4gICAgLypcbiAgICAgICAgLy8gQ3JlYXRlIEFwcFN5bmMgYW5kIGRhdGFiYXNlXG4gICAgICAgIGNvbnN0IGFwaSA9IG5ldyBhcHBzeW5jLkdyYXBocWxBcGkodGhpcywgJ0FwaScsIHtcbiAgICAgICAgICBuYW1lOiAnY2RrLW5vdGVzLWFwcHN5bmMtYXBpJyxcbiAgICAgICAgICBzY2hlbWE6IGFwcHN5bmMuU2NoZW1hLmZyb21Bc3NldCgnZ3JhcGhxbC9zY2hlbWEuZ3JhcGhxbCcpLFxuICAgICAgICAgIGF1dGhvcml6YXRpb25Db25maWc6IHtcbiAgICAgICAgICAgIGRlZmF1bHRBdXRob3JpemF0aW9uOiB7XG4gICAgICAgICAgICAgIGF1dGhvcml6YXRpb25UeXBlOiBhcHBzeW5jLkF1dGhvcml6YXRpb25UeXBlLkFQSV9LRVksXG4gICAgICAgICAgICAgIGFwaUtleUNvbmZpZzoge1xuICAgICAgICAgICAgICAgIGV4cGlyZXM6IGNkay5FeHBpcmF0aW9uLmFmdGVyKGNkay5EdXJhdGlvbi5kYXlzKDM2NSkpXG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgICB4cmF5RW5hYmxlZDogdHJ1ZSxcbiAgICAgICAgfSk7XG4gICAgXG4gICAgXG4gICAgICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsIFwiR3JhcGhRTEFQSVVSTFwiLCB7IHZhbHVlOiBhcGkuZ3JhcGhxbFVybCB9KTtcbiAgICAgICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgXCJHcmFwaFFMQVBJS2V5XCIsIHsgdmFsdWU6IGFwaS5hcGlLZXkgfHwgJycgfSk7XG4gICAgICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsIFwiU3RhY2tSZWdpb25cIiwgIHsgdmFsdWU6IHRoaXMucmVnaW9uIH0pO1xuICAgIFxuICAgICAgICBcbiAgICAgICAgY29uc3Qgbm90ZXNMYW1iZGEgPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsICdBcHBTeW5jTm90ZXNIYW5kbGVyJywge1xuICAgICAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLk5PREVKU18xMl9YLFxuICAgICAgICAgIGhhbmRsZXI6ICdtYWluLmhhbmRsZXInLFxuICAgICAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmZyb21Bc3NldCgnbGFtYmRhLWZucycpLFxuICAgICAgICAgIG1lbW9yeVNpemU6IDEwMjRcbiAgICAgICAgfSk7XG4gICAgICAgIFxuICAgICAgICAvLyBzZXQgdGhlIG5ldyBMYW1iZGEgZnVuY3Rpb24gYXMgYSBkYXRhIHNvdXJjZSBmb3IgdGhlIEFwcFN5bmMgQVBJXG4gICAgICAgIGNvbnN0IGxhbWJkYURzID0gYXBpLmFkZExhbWJkYURhdGFTb3VyY2UoJ2xhbWJkYURhdGFzb3VyY2UnLCBub3Rlc0xhbWJkYSk7XG4gICAgXG4gICAgXG4gICAgICAgIC8vIHNldCB0aGUgQ2FsbEhhbmRsZXIgZnVuY3Rpb24gYXMgdGhlIGRhdGEgc291cmNlIGZvciBBcHBTeW5jIEFQSVxuICAgICAgICBjb25zdCBsYW1iZGFEcyA9IGFwaS5hZGRMYW1iZGFEYXRhU291cmNlKCd0aGlyZENhbGwnLCB0aGlyZENhbGwpO1xuICAgIFxuICAgIFxuICAgICAgICAvLyBjcmVhdGUgcmVzb2x2ZXJzIHRvIG1hdGNoIEdyYXBoUUwgb3BlcmF0aW9ucyBpbiBzY2hlbWFcbiAgICAgICAgbGFtYmRhRHMuY3JlYXRlUmVzb2x2ZXIoe1xuICAgICAgICAgIHR5cGVOYW1lOiBcIlF1ZXJ5XCIsXG4gICAgICAgICAgZmllbGROYW1lOiBcImdldE5vdGVCeUlkXCJcbiAgICAgICAgfSk7XG4gICAgXG4gICAgICAgIGxhbWJkYURzLmNyZWF0ZVJlc29sdmVyKHtcbiAgICAgICAgICB0eXBlTmFtZTogXCJRdWVyeVwiLFxuICAgICAgICAgIGZpZWxkTmFtZTogXCJsaXN0Tm90ZXNcIlxuICAgICAgICB9KTtcbiAgICBcbiAgICAgICAgbGFtYmRhRHMuY3JlYXRlUmVzb2x2ZXIoe1xuICAgICAgICAgIHR5cGVOYW1lOiBcIk11dGF0aW9uXCIsXG4gICAgICAgICAgZmllbGROYW1lOiBcImNyZWF0ZU5vdGVcIlxuICAgICAgICB9KTtcbiAgICBcbiAgICAgICAgbGFtYmRhRHMuY3JlYXRlUmVzb2x2ZXIoe1xuICAgICAgICAgIHR5cGVOYW1lOiBcIk11dGF0aW9uXCIsXG4gICAgICAgICAgZmllbGROYW1lOiBcImRlbGV0ZU5vdGVcIlxuICAgICAgICB9KTtcbiAgICBcbiAgICAgICAgbGFtYmRhRHMuY3JlYXRlUmVzb2x2ZXIoe1xuICAgICAgICAgIHR5cGVOYW1lOiBcIk11dGF0aW9uXCIsXG4gICAgICAgICAgZmllbGROYW1lOiBcInVwZGF0ZU5vdGVcIlxuICAgICAgICB9KTtcbiAgICAqL1xuXG4gICAgY29uc3QgY2FsbEluZm9UYWJsZSA9IG5ldyBkZGIuVGFibGUodGhpcywgJ2NhbGxJbmZvJywge1xuICAgICAgcGFydGl0aW9uS2V5OiB7XG4gICAgICAgIG5hbWU6ICdwaG9uZU51bWJlcicsXG4gICAgICAgIHR5cGU6IGRkYi5BdHRyaWJ1dGVUeXBlLlNUUklOR1xuICAgICAgfSxcbiAgICAgIHJlbW92YWxQb2xpY3k6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgICBiaWxsaW5nTW9kZTogZGRiLkJpbGxpbmdNb2RlLlBBWV9QRVJfUkVRVUVTVCxcbiAgICAgIHN0cmVhbTogZGRiLlN0cmVhbVZpZXdUeXBlLk5FV19JTUFHRVxuICAgIH0pO1xuXG4gICAgLy8gZW5hYmxlIHRoZSBMYW1iZGEgZnVuY3Rpb24gdG8gYWNjZXNzIHRoZSBEeW5hbW9EQiB0YWJsZSAodXNpbmcgSUFNKVxuICAgIGNhbGxJbmZvVGFibGUuZ3JhbnRGdWxsQWNjZXNzKHRoaXJkQ2FsbClcbiAgICAvLyBwdXQgdGhlIHRhYmxlIG5hbWUgaW4gdGhlIGxhbWJkYSBlbnZpcm9ubWVudFxuICAgIHRoaXJkQ2FsbC5hZGRFbnZpcm9ubWVudCgnQ0FMTElORk9fVEFCTEVfTkFNRScsIGNhbGxJbmZvVGFibGUudGFibGVOYW1lKTtcblxuICB9XG5cbn1cbmV4cG9ydHMudGhpcmRDYWxsU3RhY2sgPSBUaGlyZENhbGxTdGFjaztcblxuIl19