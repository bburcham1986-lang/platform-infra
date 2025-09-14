// cdk/lib/cdk-stack.ts
import * as path from "path";
import {
  Stack,
  StackProps,
  Duration,
  RemovalPolicy,
  CfnOutput,
} from "aws-cdk-lib";
import { Construct } from "constructs";

import * as s3 from "aws-cdk-lib/aws-s3";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";

import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iot from "aws-cdk-lib/aws-iot";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodeLambda from "aws-cdk-lib/aws-lambda-nodejs";
import * as apigw from "aws-cdk-lib/aws-apigateway";

export class CdkStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // -----------------------------
    // Frontend hosting (S3 + CF)
    // -----------------------------
    const siteBucket = new s3.Bucket(this, "FrontendBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
    });

    const distribution = new cloudfront.Distribution(this, "FrontendCdn", {
      defaultBehavior: { origin: new origins.S3Origin(siteBucket) },
      defaultRootObject: "index.html",
      errorResponses: [
        // Single-page app routing: rewrite 403/404 to index.html
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
          ttl: Duration.minutes(0),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
          ttl: Duration.minutes(0),
        },
      ],
    });

    // -----------------------------
    // Telemetry storage (DynamoDB)
    // -----------------------------
    const telemetryTable = new dynamodb.Table(this, "TelemetryTable", {
      tableName: "telemetry",
      partitionKey: { name: "deviceId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "ts", type: dynamodb.AttributeType.NUMBER },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "ttl",
      removalPolicy: RemovalPolicy.RETAIN, // keep data
    });

    // -----------------------------
    // Ingest Lambda (IoT -> Lambda)
    // -----------------------------
    const telemetryDecoderFn = new nodeLambda.NodejsFunction(
      this,
      "TelemetryDecoderFn",
      {
        entry: path.join(__dirname, "../lambda/telemetry-decoder.ts"),
        runtime: lambda.Runtime.NODEJS_20_X,
        timeout: Duration.seconds(10),
        environment: {
          TABLE_NAME: telemetryTable.tableName,
        },
      }
    );
    telemetryTable.grantWriteData(telemetryDecoderFn);

    // IoT Topic Rule: SELECT all, add topic/timestamp, invoke Lambda
    const topicRule = new iot.CfnTopicRule(this, "TelemetryRule", {
      ruleName: "ingest_telemetry",
      topicRulePayload: {
        sql: "SELECT *, topic() as mqttTopic, timestamp() as iotTimestamp FROM 'devices/+/telemetry'",
        awsIotSqlVersion: "2016-03-23",
        ruleDisabled: false,
        actions: [
          {
            lambda: { functionArn: telemetryDecoderFn.functionArn },
          },
        ],
      },
    });

    // Allow IoT to invoke the Lambda
    telemetryDecoderFn.addPermission("AllowIotInvoke", {
      principal: new iam.ServicePrincipal("iot.amazonaws.com"),
      sourceArn: topicRule.attrArn,
    });

    // -----------------------------
    // Read API (API Gateway + Lambdas)
    // -----------------------------
    const getLatestFn = new nodeLambda.NodejsFunction(
      this,
      "GetLatestTelemetryFn",
      {
        entry: path.join(__dirname, "../lambda/get-latest.ts"),
        runtime: lambda.Runtime.NODEJS_20_X,
        timeout: Duration.seconds(10),
        environment: { TABLE_NAME: telemetryTable.tableName },
      }
    );
    const getSeriesFn = new nodeLambda.NodejsFunction(
      this,
      "GetSeriesTelemetryFn",
      {
        entry: path.join(__dirname, "../lambda/get-series.ts"),
        runtime: lambda.Runtime.NODEJS_20_X,
        timeout: Duration.seconds(10),
        environment: { TABLE_NAME: telemetryTable.tableName },
      }
    );
    telemetryTable.grantReadData(getLatestFn);
    telemetryTable.grantReadData(getSeriesFn);

    const api = new apigw.RestApi(this, "DataApi", {
      restApiName: "data-api",
      defaultCorsPreflightOptions: {
        allowOrigins: apigw.Cors.ALL_ORIGINS, // tighten later
        allowMethods: apigw.Cors.ALL_METHODS,
      },
    });

    const devices = api.root.addResource("devices");
    const byId = devices.addResource("{deviceId}");
    byId
      .addResource("latest")
      .addMethod("GET", new apigw.LambdaIntegration(getLatestFn));
    byId
      .addResource("series")
      .addMethod("GET", new apigw.LambdaIntegration(getSeriesFn));

    // -----------------------------
    // Outputs (used by your scripts)
    // -----------------------------
    new CfnOutput(this, "BucketName", { value: siteBucket.bucketName });
    new CfnOutput(this, "DistributionId", { value: distribution.distributionId });
    new CfnOutput(this, "ApiUrl", { value: api.url });
  }
}
