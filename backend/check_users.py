"""
Check users in the database.
"""
import asyncio
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'app'))

from motor.motor_asyncio import AsyncIOMotorClient
from app.core.config import settings

async def check_users():
    client = AsyncIOMotorClient(settings.mongodb_url)
    db = client[settings.database_name]

    users = await db.users.find({}).to_list(10)
    print(f"Found {len(users)} users:")
    for user in users:
        print(f"  - {user['email']} (id: {user['_id']})")

    client.close()

if __name__ == "__main__":
    asyncio.run(check_users())
