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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidGhpcmRfY2FsbC1zdGFjay5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInRoaXJkX2NhbGwtc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBQUEsbURBQW1EO0FBQ25ELHFDQUFxQztBQUNyQyxzQ0FBdUM7QUFFdkMsd0NBQXdDO0FBQ3hDLDhDQUErQztBQUMvQyxvREFBb0Q7QUFDcEQsd0NBQXlDO0FBR3pDLDZDQUE2QztBQUs3QyxNQUFhLGNBQWUsU0FBUSxHQUFHLENBQUMsS0FBSztJQUMzQyxZQUFZLEtBQW9CLEVBQUUsRUFBVSxFQUFFLEtBQXNCO1FBQ2xFLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBRXhCLE1BQU0sZUFBZSxHQUFHLElBQUksR0FBRyxDQUFDLEtBQUssQ0FBQyxJQUFJLEVBQUUsaUJBQWlCLENBQUMsQ0FBQztRQUUvRCx5RUFBeUU7UUFDekUsTUFBTSxRQUFRLEdBQUcsSUFBSSxFQUFFLENBQUMsTUFBTSxDQUFDLElBQUksRUFBRSxVQUFVLEVBQUU7WUFDL0MsZ0JBQWdCLEVBQUUsS0FBSztZQUN2QixhQUFhLEVBQUUsR0FBRyxDQUFDLGFBQWEsQ0FBQyxPQUFPO1lBQ3hDLGlCQUFpQixFQUFFLElBQUk7U0FDeEIsQ0FBQyxDQUFDO1FBQ0gsTUFBTSxtQkFBbUIsR0FBRyxJQUFJLEdBQUcsQ0FBQyxlQUFlLENBQUM7WUFDbEQsTUFBTSxFQUFFLEdBQUcsQ0FBQyxNQUFNLENBQUMsS0FBSztZQUN4QixPQUFPLEVBQUU7Z0JBQ1AsY0FBYztnQkFDZCxjQUFjO2dCQUNkLGlCQUFpQjthQUNsQjtZQUNELFNBQVMsRUFBRTtnQkFDVCxRQUFRLENBQUMsU0FBUztnQkFDbEIsR0FBRyxRQUFRLENBQUMsU0FBUyxJQUFJO2FBQzFCO1lBQ0QsR0FBRyxFQUFFLHlCQUF5QjtTQUMvQixDQUFDLENBQUM7UUFDSCxtQkFBbUIsQ0FBQyxtQkFBbUIsQ0FBQyxvQ0FBb0MsQ0FBQyxD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QUFuUEQsd0NBbVBDO0FBQ0QsT0FBTyxDQUFDLGNBQWMsR0FBRyxjQUFjLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyIvLyAg4oCcQ29weXJpZ2h0IEFtYXpvbi5jb20gSW5jLiBvciBpdHMgYWZmaWxpYXRlcy7igJ0gXG5pbXBvcnQgKiBhcyBjZGsgZnJvbSAnQGF3cy1jZGsvY29yZSc7XG5pbXBvcnQgczMgPSByZXF1aXJlKCdAYXdzLWNkay9hd3MtczMnKTtcbmltcG9ydCBzM2RlcGxveSA9IHJlcXVpcmUoJ0Bhd3MtY2RrL2F3cy1zMy1kZXBsb3ltZW50JylcbmltcG9ydCBpYW0gPSByZXF1aXJlKCdAYXdzLWNkay9hd3MtaWFtJylcbmltcG9ydCBsYW1iZGEgPSByZXF1aXJlKCdAYXdzLWNkay9hd3MtbGFtYmRhJyk7XG5pbXBvcnQgY3VzdG9tID0gcmVxdWlyZSgnQGF3cy1jZGsvY3VzdG9tLXJlc291cmNlcycpXG5pbXBvcnQgc3FzID0gcmVxdWlyZSgnQGF3cy1jZGsvYXdzLXNxcycpO1xuXG5pbXBvcnQgKiBhcyBhcHBzeW5jIGZyb20gJ0Bhd3MtY2RrL2F3cy1hcHBzeW5jJztcbmltcG9ydCAqIGFzIGRkYiBmcm9tICdAYXdzLWNkay9hd3MtZHluYW1vZGInO1xuaW1wb3J0IHsgRnJvbUNsb3VkRm9ybWF0aW9uUHJvcGVydHlPYmplY3QgfSBmcm9tICdAYXdzLWNkay9jb3JlL2xpYi9jZm4tcGFyc2UnO1xuaW1wb3J0IHsgQ2hpbWVDbGllbnQgfSBmcm9tICdAYXdzLXNkay9jbGllbnQtY2hpbWUnO1xuaW1wb3J0IHsgc3RyaW5naWZ5IH0gZnJvbSAncXVlcnlzdHJpbmcnO1xuXG5leHBvcnQgY2xhc3MgVGhpcmRDYWxsU3RhY2sgZXh0ZW5kcyBjZGsuU3RhY2sge1xuICBjb25zdHJ1Y3RvcihzY29wZTogY2RrLkNvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM/OiBjZGsuU3RhY2tQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCwgcHJvcHMpO1xuXG4gICAgY29uc3QgZGVhZExldHRlclF1ZXVlID0gbmV3IHNxcy5RdWV1ZSh0aGlzLCAnZGVhZExldHRlclF1ZXVlJyk7XG5cbiAgICAvLyBjcmVhdGUgYSBidWNrZXQgZm9yIHRoZSByZWNvcmRlZCB3YXZlIGZpbGVzIGFuZCBzZXQgdGhlIHJpZ2h0IHBvbGljaWVzXG4gICAgY29uc3Qgd2F2RmlsZXMgPSBuZXcgczMuQnVja2V0KHRoaXMsICd3YXZGaWxlcycsIHtcbiAgICAgIHB1YmxpY1JlYWRBY2Nlc3M6IGZhbHNlLFxuICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcbiAgICAgIGF1dG9EZWxldGVPYmplY3RzOiB0cnVlXG4gICAgfSk7XG4gICAgY29uc3Qgd2F2RmlsZUJ1Y2tldFBvbGljeSA9IG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgJ3MzOkdldE9iamVjdCcsXG4gICAgICAgICdzMzpQdXRPYmplY3QnLFxuICAgICAgICAnczM6UHV0T2JqZWN0QWNsJ1xuICAgICAgXSxcbiAgICAgIHJlc291cmNlczogW1xuICAgICAgICB3YXZGaWxlcy5idWNrZXRBcm4sXG4gICAgICAgIGAke3dhdkZpbGVzLmJ1Y2tldEFybn0vKmBcbiAgICAgIF0sXG4gICAgICBzaWQ6ICdTSVBNZWRpYUFwcGxpY2F0aW9uUmVhZCcsXG4gICAgfSk7XG4gICAgd2F2RmlsZUJ1Y2tldFBvbGljeS5hZGRTZXJ2aWNlUHJpbmNpcGFsKCd2b2ljZWNvbm5lY3Rvci5jaGltZS5hbWF6b25hd3MuY29tJyk7XG4gICAgd2F2RmlsZXMuYWRkVG9SZXNvdXJjZVBvbGljeSh3YXZGaWxlQnVja2V0UG9saWN5KTtcbiAgICAvKlxuICAgICAgICBuZXcgczNkZXBsb3kuQnVja2V0RGVwbG95bWVudCh0aGlzLCAnV2F2RGVwbG95Jywge1xuICAgICAgICAgIHNvdXJjZXM6IFtzM2RlcGxveS5Tb3VyY2UuYXNzZXQoJy4vd2F2X2ZpbGVzJyldLFxuICAgICAgICAgIGRlc3RpbmF0aW9uQnVja2V0OiB3YXZGaWxlcyxcbiAgICAgICAgICBjb250ZW50VHlwZTogJ2F1ZGlvL3dhdidcbiAgICAgICAgfSk7XG4gICAgKi9cbiAgICBjb25zdCBzbWFMYW1iZGFSb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsICdzbWFMYW1iZGFSb2xlJywge1xuICAgICAgYXNzdW1lZEJ5OiBuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoJ2xhbWJkYS5hbWF6b25hd3MuY29tJyksXG4gICAgfSk7XG4gICAgc21hTGFtYmRhUm9sZS5hZGRNYW5hZ2VkUG9saWN5KGlhbS5NYW5hZ2VkUG9saWN5LmZyb21Bd3NNYW5hZ2VkUG9saWN5TmFtZShcInNlcnZpY2Utcm9sZS9BV1NMYW1iZGFCYXNpY0V4ZWN1dGlvblJvbGVcIikpO1xuXG4gICAgY29uc3QgcG9sbHlSb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsICdwb2xseVJvbGUnLCB7XG4gICAgICBhc3N1bWVkQnk6IG5ldyBpYW0uU2VydmljZVByaW5jaXBhbCgnbGFtYmRhLmFtYXpvbmF3cy5jb20nKSxcbiAgICB9KTtcblxuICAgIGNvbnN0IHBvbGx5UG9saWN5RG9jID0gbmV3IGlhbS5Qb2xpY3lEb2N1bWVudCh7XG4gICAgICBzdGF0ZW1lbnRzOiBbXG4gICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICAgICAgLy9hY3Rpb25zOiBbXCJwb2xseTpTdGFydFNwZWVjaFN5bnRoZXNpc1Rhc2tcIixcInBvbGx5Okxpc3RTcGVlY2hTeW50aGVzaXNUYXNrc1wiLFwicG9sbHk6R2V0U3BlZWNoU3ludGhlc2lzVGFza1wiXSxcbiAgICAgICAgICBhY3Rpb25zOiBbXCJwb2xseTpTeW50aGVzaXplU3BlZWNoXCJdLFxuICAgICAgICAgIHJlc291cmNlczogW1wiKlwiXSxcbiAgICAgICAgfSksXG4gICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICAgICAgYWN0aW9uczogW1wiczM6UHV0T2JqZWN0XCIsIFwiczM6TGlzdE9iamVjdFwiXSxcbiAgICAgICAgICByZXNvdXJjZXM6IFtgJHt3YXZGaWxlcy5idWNrZXRBcm59LypgXSxcbiAgICAgICAgfSksLypcbiAgICAgICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgICAgICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICAgICAgICAgICAgYWN0aW9uczogW1wic25zOlB1Ymxpc2hcIl0sXG4gICAgICAgICAgICAgICAgcmVzb3VyY2VzOiBbXCIqXCJdLFxuICAgICAgICAgICAgfSksKi9cbiAgICAgIF0sXG4gICAgfSk7XG4gICAgY29uc3QgcG9sbHlQb2xsaWN5ID0gbmV3IGlhbS5Qb2xpY3kodGhpcywgJ3BvbGx5UG9sbGljeScsIHtcbiAgICAgIGRvY3VtZW50OiBwb2xseVBvbGljeURvY1xuICAgIH0pO1xuICAgIHNtYUxhbWJkYVJvbGUuYXR0YWNoSW5saW5lUG9saWN5KHBvbGx5UG9sbGljeSk7XG5cbiAgICAvLyBjcmVhdGUgdGhlIGxhbWJkYSBmdW5jdGlvbiB0aGF0IGRvZXMgdGhlIGNhbGxcbiAgICBjb25zdCB0aGlyZENhbGwgPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsICd0aGlyZENhbGwnLCB7XG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5mcm9tQXNzZXQoXCJzcmNcIiwgeyBleGNsdWRlOiBbXCJSRUFETUUubWRcIl0gfSksXG4gICAgICBoYW5kbGVyOiAndGhpcmRDYWxsLmhhbmRsZXInLFxuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzE0X1gsXG4gICAgICBlbnZpcm9ubWVudDoge1xuICAgICAgICBXQVZGSUxFX0JVQ0tFVDogd2F2RmlsZXMuYnVja2V0TmFtZSxcbiAgICAgIH0sXG4gICAgICByb2xlOiBzbWFMYW1iZGFSb2xlLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoNjApXG4gICAgfSk7XG4gICAgY29uc3QgY2hpbWVDcmVhdGVSb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsICdjcmVhdGVDaGltZUxhbWJkYVJvbGUnLCB7XG4gICAgICBhc3N1bWVkQnk6IG5ldyBpYW0uU2VydmljZVByaW5jaXBhbCgnbGFtYmRhLmFtYXpvbmF3cy5jb20nKSxcbiAgICAgIGlubGluZVBvbGljaWVzOiB7XG4gICAgICAgIFsnY2hpbWVQb2xpY3knXTogbmV3IGlhbS5Qb2xpY3lEb2N1bWVudCh7XG4gICAgICAgICAgc3RhdGVtZW50czogW25ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgICAgIHJlc291cmNlczogWycqJ10sXG4gICAgICAgICAgICBhY3Rpb25zOiBbJ2NoaW1lOionLFxuICAgICAgICAgICAgICAnbGFtYmRhOkdldFBvbGljeScsXG4gICAgICAgICAgICAgICdsYW1iZGE6QWRkUGVybWlzc2lvbicsXG4gICAgICAgICAgICAgICdjbG91ZGZvcm1hdGlvbjpEZXNjcmliZVN0YWNrcycsXG4gICAgICAgICAgICAgICdjbG91ZGZvcm1hdGlvbjpEZXNjcmliZVN0YWNrRXZlbnRzJyxcbiAgICAgICAgICAgICAgJ2Nsb3VkZm9ybWF0aW9uOkRlc2NyaWJlU3RhY2tSZXNvdXJjZScsXG4gICAgICAgICAgICAgICdjbG91ZGZvcm1hdGlvbjpEZXNjcmliZVN0YWNrUmVzb3VyY2VzJyxdXG4gICAgICAgICAgfSldXG4gICAgICAgIH0pXG4gICAgICB9LFxuICAgICAgbWFuYWdlZFBvbGljaWVzOiBbaWFtLk1hbmFnZWRQb2xpY3kuZnJvbUF3c01hbmFnZWRQb2xpY3lOYW1lKFwic2VydmljZS1yb2xlL0FXU0xhbWJkYUJhc2ljRXhlY3V0aW9uUm9sZVwiKV1cbiAgICB9KTtcblxuICAgIC8qXG4gICAgICAgIC8vIGNyZWF0ZSB0aGUgbGFtYmRhIGZvciBDREsgY3VzdG9tIHJlc291cmNlIHRvIGRlcGxveSBTTUEsIGV0Yy5cbiAgICAgICAgY29uc3QgY2hpbWVDREtzdXBwb3J0TGFtYmRhID0gbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCAnY2hpbWVDREtzdXBwb3J0TGFtYmRhJywge1xuICAgICAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmZyb21Bc3NldChcImNoaW1lLWNkay1zdXBwb3J0XCIsIHsgZXhjbHVkZTogW1wiUkVBRE1FLm1kXCJdIH0pLFxuICAgICAgICAgIGhhbmRsZXI6ICdjaGltZS1jZGstc3VwcG9ydC5vbl9ldmVudCcsXG4gICAgICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuUFlUSE9OXzNfOSxcbiAgICAgICAgICByb2xlOiBjaGltZUNyZWF0ZVJvbGUsXG4gICAgICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoNjApXG4gICAgICAgIH0pO1xuICAgICovXG5cbiAgICAvLyBjcmVhdGUgdGhlIGxhbWJkYSBmb3IgQ0RLIGN1c3RvbSByZXNvdXJjZSB0byBkZXBsb3kgU01BLCBldGMuXG4gICAgY29uc3QgY2hpbWVDREtzdXBwb3J0TGFtYmRhID0gbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCAnY2hpbWVDREtzdXBwb3J0TGFtYmRhJywge1xuICAgICAgY29kZTogbGFtYmRhLkNvZGUuZnJvbUFzc2V0KFwibGFtYmRhXCIsIHsgZXhjbHVkZTogW1wiUkVBRE1FLm1kXCJdIH0pLFxuICAgICAgaGFuZGxlcjogJ2luZGV4LmhhbmRsZXInLFxuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuTk9ERUpTXzE0X1gsXG4gICAgICByb2xlOiBjaGltZUNyZWF0ZVJvbGUsXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcygxMjApLFxuICAgIH0pO1xuXG4gICAgY29uc3QgY2hpbWVQcm92aWRlciA9IG5ldyBjdXN0b20uUHJvdmlkZXIodGhpcywgJ2NoaW1lUHJvdmlkZXInLCB7XG4gICAgICBvbkV2ZW50SGFuZGxlcjogY2hpbWVDREtzdXBwb3J0TGFtYmRhXG4gICAgfSk7XG5cbiAgICAvLyBuZWVkIHR5cGUgZGVjbGFyYXRpb25zXG4gICAgLy8gaHR0cHM6Ly93d3cudHlwZXNjcmlwdGxhbmcub3JnL2RvY3MvaGFuZGJvb2svZGVjbGFyYXRpb24tZmlsZXMvaW50cm9kdWN0aW9uLmh0bWxcbiAgICBjb25zdCBjaGltZVByb3ZpZGVyUHJvcGVydGllcyA9IHtcbiAgICAgIGxhbWJkYUFybjogdGhpcmRDYWxsLmZ1bmN0aW9uQXJuLFxuICAgICAgcmVnaW9uOiB0aGlzLnJlZ2lvbixcbiAgICAgIHNtYU5hbWU6IHRoaXMuc3RhY2tOYW1lLFxuICAgICAgc2lwUnVsZU5hbWU6IHRoaXMuc3RhY2tOYW1lLFxuICAgICAgc2lwVHJpZ2dlclR5cGU6ICdUb1Bob25lTnVtYmVyJyxcbiAgICAgIHBob25lTnVtYmVyUmVxdWlyZWQ6IHRydWUsXG4gICAgICBwaG9uZUFyZWFDb2RlOiAnNTA1JyxcbiAgICAgIHBob25lU3RhdGU6ICcnLFxuICAgICAgcGhvbmVDb3VudHJ5OiAnJyxcbiAgICAgIHBob25lTnVtYmVyVHlwZTogJ1NpcE1lZGlhQXBwbGljYXRpb25EaWFsSW4nLCAvLyBCdXNpbmVzc0NhbGxpbmcgfCBWb2ljZUNvbm5lY3RvciB8IFNpcE1lZGlhQXBwbGljYXRpb25EaWFsSW5cbiAgICAgIHBob25lTnVtYmVyVG9sbEZyZWVQcmVmaXg6ICcnLFxuICAgIH1cbiAgICBjb25zb2xlLmxvZyhjaGltZVByb3ZpZGVyUHJvcGVydGllcyk7XG4gICAgY29uc29sZS5sb2coY2hpbWVQcm92aWRlci5zZXJ2aWNlVG9rZW4pO1xuXG4gICAgY29uc3QgaW5ib3VuZFNNQSA9IG5ldyBjZGsuQ3VzdG9tUmVzb3VyY2UodGhpcywgJ2luYm91bmRTTUEnLCB7XG4gICAgICBzZXJ2aWNlVG9rZW46IGNoaW1lUHJvdmlkZXIuc2VydmljZVRva2VuLFxuICAgICAgcHJvcGVydGllczogY2hpbWVQcm92aWRlclByb3BlcnRpZXMsXG4gICAgfSk7XG5cbiAgICAvLyB0aGVzZSBhcmUgdGhlIGF0dHJpYnV0ZXMgcmV0dXJuZWQgZnJvbSB0aGUgY3VzdG9tIHJlc291cmNlIVxuICAgIGNvbnN0IGluYm91bmRQaG9uZU51bWJlciA9IGluYm91bmRTTUEuZ2V0QXR0U3RyaW5nKCdwaG9uZU51bWJlcicpO1xuICAgIGNvbnN0IHNtYUlEID0gaW5ib3VuZFNNQS5nZXRBdHRTdHJpbmcoXCJzbWFJRFwiKTtcbiAgICBjb25zdCBzaXBSdWxlSUQgPSBpbmJvdW5kU01BLmdldEF0dFN0cmluZyhcInNpcFJ1bGVJRFwiKTtcbiAgICBjb25zdCBzaXBSdWxlTmFtZSA9IGluYm91bmRTTUEuZ2V0QXR0U3RyaW5nKFwic2lwUnVsZU5hbWVcIik7XG5cbiAgICAvLyBXcml0ZSB0aGUgVGVsZXBob255IEhhbmRsaW5nIERhdGEgdG8gdGhlIG91dHB1dFxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdyZWdpb24nLCB7IHZhbHVlOiB0aGlzLnJlZ2lvbiB9KTtcbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnaW5ib3VuZFBob25lTnVtYmVyJywgeyB2YWx1ZTogaW5ib3VuZFBob25lTnVtYmVyIH0pO1xuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdsYW1iZGFMb2cnLCB7IHZhbHVlOiB0aGlyZENhbGwubG9nR3JvdXAubG9nR3JvdXBOYW1lIH0pO1xuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdsYW1iZGFBUk4nLCB7IHZhbHVlOiB0aGlyZENhbGwuZnVuY3Rpb25Bcm4gfSk7XG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgXCJzbWFJRFwiLCB7IHZhbHVlOiBzbWFJRCB9KTtcbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCBcInNpcFJ1bGVJRFwiLCB7IHZhbHVlOiBzaXBSdWxlSUQgfSk7XG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgXCJzaXBSdWxlTmFtZVwiLCB7IHZhbHVlOiBzaXBSdWxlTmFtZSB9KTtcbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAncHJvdmlkZXJMb2cnLCB7IHZhbHVlOiB0aGlyZENhbGwubG9nR3JvdXAubG9nR3JvdXBOYW1lIH0pO1xuXG4gICAgLypcbiAgICAgICAgLy8gQ3JlYXRlIEFwcFN5bmMgYW5kIGRhdGFiYXNlXG4gICAgICAgIGNvbnN0IGFwaSA9IG5ldyBhcHBzeW5jLkdyYXBocWxBcGkodGhpcywgJ0FwaScsIHtcbiAgICAgICAgICBuYW1lOiAnY2RrLW5vdGVzLWFwcHN5bmMtYXBpJyxcbiAgICAgICAgICBzY2hlbWE6IGFwcHN5bmMuU2NoZW1hLmZyb21Bc3NldCgnZ3JhcGhxbC9zY2hlbWEuZ3JhcGhxbCcpLFxuICAgICAgICAgIGF1dGhvcml6YXRpb25Db25maWc6IHtcbiAgICAgICAgICAgIGRlZmF1bHRBdXRob3JpemF0aW9uOiB7XG4gICAgICAgICAgICAgIGF1dGhvcml6YXRpb25UeXBlOiBhcHBzeW5jLkF1dGhvcml6YXRpb25UeXBlLkFQSV9LRVksXG4gICAgICAgICAgICAgIGFwaUtleUNvbmZpZzoge1xuICAgICAgICAgICAgICAgIGV4cGlyZXM6IGNkay5FeHBpcmF0aW9uLmFmdGVyKGNkay5EdXJhdGlvbi5kYXlzKDM2NSkpXG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgICB4cmF5RW5hYmxlZDogdHJ1ZSxcbiAgICAgICAgfSk7XG4gICAgXG4gICAgXG4gICAgICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsIFwiR3JhcGhRTEFQSVVSTFwiLCB7IHZhbHVlOiBhcGkuZ3JhcGhxbFVybCB9KTtcbiAgICAgICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgXCJHcmFwaFFMQVBJS2V5XCIsIHsgdmFsdWU6IGFwaS5hcGlLZXkgfHwgJycgfSk7XG4gICAgICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsIFwiU3RhY2tSZWdpb25cIiwgIHsgdmFsdWU6IHRoaXMucmVnaW9uIH0pO1xuICAgIFxuICAgICAgICBcbiAgICAgICAgY29uc3Qgbm90ZXNMYW1iZGEgPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsICdBcHBTeW5jTm90ZXNIYW5kbGVyJywge1xuICAgICAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLk5PREVKU18xMl9YLFxuICAgICAgICAgIGhhbmRsZXI6ICdtYWluLmhhbmRsZXInLFxuICAgICAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmZyb21Bc3NldCgnbGFtYmRhLWZucycpLFxuICAgICAgICAgIG1lbW9yeVNpemU6IDEwMjRcbiAgICAgICAgfSk7XG4gICAgICAgIFxuICAgICAgICAvLyBzZXQgdGhlIG5ldyBMYW1iZGEgZnVuY3Rpb24gYXMgYSBkYXRhIHNvdXJjZSBmb3IgdGhlIEFwcFN5bmMgQVBJXG4gICAgICAgIGNvbnN0IGxhbWJkYURzID0gYXBpLmFkZExhbWJkYURhdGFTb3VyY2UoJ2xhbWJkYURhdGFzb3VyY2UnLCBub3Rlc0xhbWJkYSk7XG4gICAgXG4gICAgXG4gICAgICAgIC8vIHNldCB0aGUgQ2FsbEhhbmRsZXIgZnVuY3Rpb24gYXMgdGhlIGRhdGEgc291cmNlIGZvciBBcHBTeW5jIEFQSVxuICAgICAgICBjb25zdCBsYW1iZGFEcyA9IGFwaS5hZGRMYW1iZGFEYXRhU291cmNlKCd0aGlyZENhbGwnLCB0aGlyZENhbGwpO1xuICAgIFxuICAgIFxuICAgICAgICAvLyBjcmVhdGUgcmVzb2x2ZXJzIHRvIG1hdGNoIEdyYXBoUUwgb3BlcmF0aW9ucyBpbiBzY2hlbWFcbiAgICAgICAgbGFtYmRhRHMuY3JlYXRlUmVzb2x2ZXIoe1xuICAgICAgICAgIHR5cGVOYW1lOiBcIlF1ZXJ5XCIsXG4gICAgICAgICAgZmllbGROYW1lOiBcImdldE5vdGVCeUlkXCJcbiAgICAgICAgfSk7XG4gICAgXG4gICAgICAgIGxhbWJkYURzLmNyZWF0ZVJlc29sdmVyKHtcbiAgICAgICAgICB0eXBlTmFtZTogXCJRdWVyeVwiLFxuICAgICAgICAgIGZpZWxkTmFtZTogXCJsaXN0Tm90ZXNcIlxuICAgICAgICB9KTtcbiAgICBcbiAgICAgICAgbGFtYmRhRHMuY3JlYXRlUmVzb2x2ZXIoe1xuICAgICAgICAgIHR5cGVOYW1lOiBcIk11dGF0aW9uXCIsXG4gICAgICAgICAgZmllbGROYW1lOiBcImNyZWF0ZU5vdGVcIlxuICAgICAgICB9KTtcbiAgICBcbiAgICAgICAgbGFtYmRhRHMuY3JlYXRlUmVzb2x2ZXIoe1xuICAgICAgICAgIHR5cGVOYW1lOiBcIk11dGF0aW9uXCIsXG4gICAgICAgICAgZmllbGROYW1lOiBcImRlbGV0ZU5vdGVcIlxuICAgICAgICB9KTtcbiAgICBcbiAgICAgICAgbGFtYmRhRHMuY3JlYXRlUmVzb2x2ZXIoe1xuICAgICAgICAgIHR5cGVOYW1lOiBcIk11dGF0aW9uXCIsXG4gICAgICAgICAgZmllbGROYW1lOiBcInVwZGF0ZU5vdGVcIlxuICAgICAgICB9KTtcbiAgICAqL1xuXG4gICAgY29uc3QgY2FsbEluZm9UYWJsZSA9IG5ldyBkZGIuVGFibGUodGhpcywgJ2NhbGxJbmZvJywge1xuICAgICAgcGFydGl0aW9uS2V5OiB7XG4gICAgICAgIG5hbWU6ICdwaG9uZU51bWJlcicsXG4gICAgICAgIHR5cGU6IGRkYi5BdHRyaWJ1dGVUeXBlLlNUUklOR1xuICAgICAgfSxcbiAgICAgIHJlbW92YWxQb2xpY3k6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksXG4gICAgICBiaWxsaW5nTW9kZTogZGRiLkJpbGxpbmdNb2RlLlBBWV9QRVJfUkVRVUVTVCxcbiAgICAgIHN0cmVhbTogZGRiLlN0cmVhbVZpZXdUeXBlLk5FV19JTUFHRVxuICAgIH0pO1xuXG4gICAgLy8gZW5hYmxlIHRoZSBMYW1iZGEgZnVuY3Rpb24gdG8gYWNjZXNzIHRoZSBEeW5hbW9EQiB0YWJsZSAodXNpbmcgSUFNKVxuICAgIGNhbGxJbmZvVGFibGUuZ3JhbnRGdWxsQWNjZXNzKHRoaXJkQ2FsbClcbiAgICAvLyBwdXQgdGhlIHRhYmxlIG5hbWUgaW4gdGhlIGxhbWJkYSBlbnZpcm9ubWVudFxuICAgIHRoaXJkQ2FsbC5hZGRFbnZpcm9ubWVudCgnQ0FMTElORk9fVEFCTEVfTkFNRScsIGNhbGxJbmZvVGFibGUudGFibGVOYW1lKTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICd0aGlyZENhbGxJbmZvVGFibGUnLCB7IHZhbHVlOiBjYWxsSW5mb1RhYmxlLnRhYmxlTmFtZSB9KTtcbiAgfVxuXG59XG5leHBvcnRzLnRoaXJkQ2FsbFN0YWNrID0gVGhpcmRDYWxsU3RhY2s7XG5cbiJdfQ==