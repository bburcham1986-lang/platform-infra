// cdk/functions/telemetry-api.ts
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";

const TABLE_NAME = process.env.TABLE_NAME!;
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

function json(status: number, body: unknown) {
  return {
    statusCode: status,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

export const handler = async (event: any) => {
  const rawPath: string =
    event?.rawPath ||
    event?.requestContext?.http?.path ||
    "";

  // /devices/{deviceId}/latest
  let m = rawPath.match(/^\/devices\/([^/]+)\/latest$/);
  if (m) {
    const deviceId = decodeURIComponent(m[1]);
    const res = await ddb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: "deviceId = :d",
        ExpressionAttributeValues: { ":d": deviceId },
        Limit: 1,
        ScanIndexForward: false, // newest first
      })
    );
    const item = res.Items?.[0];
    if (!item) return json(404, { message: "not found" });
    return json(200, item);
  }

  // /devices/{deviceId}/series?limit=20
  m = rawPath.match(/^\/devices\/([^/]+)\/series$/);
  if (m) {
    const deviceId = decodeURIComponent(m[1]);
    const limit = Math.max(
      1,
      Math.min(1000, Number(event?.queryStringParameters?.limit) || 20)
    );
    const res = await ddb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: "deviceId = :d",
        ExpressionAttributeValues: { ":d": deviceId },
        Limit: limit,
        ScanIndexForward: true, // oldest first (flip if you prefer newest first)
      })
    );
    return json(200, res.Items ?? []);
  }

  return json(404, { message: "route not found", pathTried: rawPath });
};
