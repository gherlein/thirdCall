PHONENUM  := +14153687546

STACKNAME := ThirdCallStack
CDK-OUT   := cdk-outputs.json
DUMMY     := $(shell touch ${CDK-OUT})
LAMBDALOG := $(shell jq .${STACKNAME}.thirdCallLambdaLog ${CDK-OUT})
LAMBDAARN := $(shell jq .${STACKNAME}.thirdCallLambdaARN ${CDK-OUT})
TABLENAME := $(shell jq .${STACKNAME}.thirdCallInfoTable ${CDK-OUT})
SMAID     := $(shell jq .${STACKNAME}.smaID ${CDK-OUT})
RULEID    := $(shell jq .${STACKNAME}.sipRuleID ${CDK-OUT})
SMANUM    := $(shell jq .${STACKNAME}.inboundPhoneNumber ${CDK-OUT})
SMANAME   := ${PHONENUM} # this is a hack!  Need to pass it back from the python create script

MODULES   := @aws-cdk/core @aws-cdk/aws-appsync @aws-cdk/aws-lambda @aws-cdk/aws-dynamodb @aws-cdk/aws-s3 @aws-cdk/aws-s3-deployment @aws-cdk/aws-iam @aws-cdk/custom-resources @aws-cdk/aws-sqs

IN_EVENT  := ./test/in.json
OUT_JSON  := ./out/out.json

DELKEY    := $(shell jq '.phoneNumber.S = "${PHONENUM}"' ./test/delete.json )  
QUOTE     := ' # this is a hack to get the command line to render correctly for cleardb target

init:
	cdk init --language=typescript
	
build:
	npm run build

deploy:
	cdk deploy --outputs-file ./cdk-outputs.json


logs:
	aws logs tail $(LAMBDALOG) --follow --format short 

logs-info:
	aws logs tail $(LAMBDALOG) --follow --format short --filter-pattern INFO

clean:
	-rm *~
	-rm cdk-outputs.json

watch:
	saw watch $(LAMBDALOG) --filter INFO --expand

invoke:
	echo ${LAMBDAARN}
	jq . ${IN_EVENT}
	aws lambda invoke --function-name ${LAMBDAARN} --cli-binary-format raw-in-base64-out --payload file://${IN_EVENT} ${OUT_JSON}
	jq . ${OUT_JSON}

cleardb:
	aws dynamodb delete-item --table-name ${TABLENAME} --key ${QUOTE}${DELKEY}${QUOTE}

destroy:
	cdk destroy

install-tools:
	sudo apt install -y jq	

modules:
	npm install ${MODULES} 	


delete-chime: 
	make delete-rule
	make delete-phone 
	make delete-sma 
	-aws chime list-sip-media-applications --no-cli-pager
	-aws chime list-sip-rules --no-cli-pager
	-aws chime list-phone-numbers --no-cli-pager

delete-sma:
	-aws chime delete-sip-media-application --sip-media-application-id ${SMAID} --no-cli-pager

delete-phone:
	-aws chime delete-phone-number --phone-number-id ${SMANUM} --no-cli-pager

delete-rule:
	-aws chime update-sip-rule --sip-rule-id  ${RULEID} --name ${SMANAME} --disabled --no-cli-pager
	-aws chime delete-sip-rule --sip-rule-id  ${RULEID} --no-cli-pager


