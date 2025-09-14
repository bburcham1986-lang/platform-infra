import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.TABLE_NAME!;

export const handler = async (event: any) => {
  const deviceId = event.pathParameters?.deviceId;
  const limit = Math.min(
    parseInt(event.queryStringParameters?.limit ?? "100", 10) || 100,
    1000
  );
  if (!deviceId) return { statusCode: 400, body: "Missing deviceId" };

  const out = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "deviceId = :d",
      ExpressionAttributeValues: { ":d": deviceId },
      ScanIndexForward: false,
      Limit: limit,
    })
  );

  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(out.Items ?? []),
  };
};
