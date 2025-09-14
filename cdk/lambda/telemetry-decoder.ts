import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";

const ddb = new DynamoDBClient({});
const TABLE = process.env.TABLE_NAME!;

function extractFromTopic(topic?: string): string | undefined {
  if (!topic) return undefined;
  // expected: devices/{deviceId}/telemetry
  const parts = topic.split("/");
  return parts.length >= 3 ? parts[1] : undefined;
}

export const handler = async (event: any) => {
  console.log("event:", JSON.stringify(event));

  // Accept either explicit fields or derive deviceId from topic
  const deviceId = String(event.deviceId ?? extractFromTopic(event.mqttTopic) ?? "");
  if (!deviceId) throw new Error("Missing deviceId");

  const ts = Number(event.ts ?? Date.now());
  const ttl = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30; // 30 days

  // Store full payload as JSON string; you can project specific fields later
  const item = {
    deviceId: { S: deviceId },
    ts:       { N: String(ts) },
    data:     { S: JSON.stringify(event) },
    ttl:      { N: String(ttl) },
  };

  await ddb.send(new PutItemCommand({ TableName: TABLE, Item: item }));
  return { ok: true };
};
