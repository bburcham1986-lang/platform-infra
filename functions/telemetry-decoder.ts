// functions/telemetry-decoder.ts
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.TABLE_NAME!;

export const handler = async (event: any) => {
  // IoT Rule can send the original JSON; support both string and object
  const msg = typeof event === "string" ? JSON.parse(event) : event;

  const deviceId = msg.deviceId ?? msg.deviceID ?? "unknown";
  const ts = Number(msg.ts ?? msg.timestamp ?? Date.now());
  const ttl = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365; // 1 year

  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: {
      deviceId,
      ts,
      data: JSON.stringify(msg),
      ttl,
    },
  }));

  return { ok: true };
};
