// Amazon DynamoDB store (Floci locally, real AWS in the cloud).
// Table names: <DYNAMODB_TABLE_PREFIX><Name>, e.g. TbxUsers, TbxListings.
// No keys in the code: on Lambda the IAM role gives permission,
// on your PC the "floci" AWS profile + AWS_ENDPOINT_URL do.
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand, ScanCommand, QueryCommand
} = require('@aws-sdk/lib-dynamodb');
const { versionConflict } = require('./memoryStore');

function createDynamoStore(schema, prefix) {
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true }
  });

  async function putConditional(TableName, Item, ConditionExpression, values) {
    try {
      await db.send(new PutCommand({
        TableName, Item, ConditionExpression,
        ...(values ? { ExpressionAttributeValues: values } : {})
      }));
      return Item;
    } catch (err) {
      if (err.name === 'ConditionalCheckFailedException') throw versionConflict();
      throw err;
    }
  }

  async function collect(command, params) {
    const items = [];
    let ExclusiveStartKey;
    do {
      const out = await db.send(new command({ ...params, ExclusiveStartKey }));
      items.push(...(out.Items || []));
      ExclusiveStartKey = out.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return items;
  }

  const tables = {};
  for (const [key, def] of Object.entries(schema)) {
    const TableName = `${prefix}${def.name}`;
    tables[key] = {
      async get(id) {
        const out = await db.send(new GetCommand({ TableName, Key: { id } }));
        return out.Item;
      },
      async create(item) {
        return putConditional(TableName, { ...item, version: 1 }, 'attribute_not_exists(id)');
      },
      async update(item, expectedVersion) {
        // Optimistic locking: fails if another request changed the item first
        return putConditional(TableName, { ...item, version: expectedVersion + 1 },
          'attribute_exists(id) AND version = :v', { ':v': expectedVersion });
      },
      async remove(id) {
        await db.send(new DeleteCommand({ TableName, Key: { id } }));
        return true;
      },
      async scan() {
        return collect(ScanCommand, { TableName });
      },
      async queryBy(attr, value) {
        const IndexName = def.indexes[attr];
        if (!IndexName) throw new Error(`No index on ${def.name}.${attr}`);
        return collect(QueryCommand, {
          TableName, IndexName,
          KeyConditionExpression: '#k = :v',
          ExpressionAttributeNames: { '#k': attr },
          ExpressionAttributeValues: { ':v': value }
        });
      }
    };
  }
  return { kind: 'dynamodb', tables };
}

module.exports = { createDynamoStore };
