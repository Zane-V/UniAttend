import { Db, MongoClient } from 'mongodb';

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || 'uniattend';

interface MongoConnection {
  client: MongoClient;
  db: Db;
}

declare global {
  var uniAttendMongo: Promise<MongoConnection> | undefined;
}

export async function getMongoDb() {
  if (!uri) {
    throw new Error('Missing MONGODB_URI environment variable.');
  }

  if (!global.uniAttendMongo) {
    const client = new MongoClient(uri);
    global.uniAttendMongo = client.connect().then(async connectedClient => {
      const db = connectedClient.db(dbName);

      await Promise.all([
        db.collection('students').createIndex({ regNumber: 1 }, { unique: true }),
        db.collection('students').createIndex({ faculty: 1 }),
        db.collection('students').createIndex({ department: 1 }),
        db.collection('students').createIndex({ level: 1 }),
        db.collection('checkIns').createIndex({ sessionId: 1 }),
        db.collection('checkIns').createIndex({ regNumber: 1 }),
        db.collection('checkIns').createIndex({ level: 1 }),
        db.collection('meta').createIndex({ key: 1 }, { unique: true }),
      ]);

      return { client: connectedClient, db };
    });
  }

  return global.uniAttendMongo;
}
