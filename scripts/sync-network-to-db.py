#!/usr/bin/env python3
"""Sync ShadowDB relationship edges to the relationships table."""

import json
import re
import sys
from pathlib import Path

# Add shadow-scripts to path
sys.path.insert(0, str(Path.home() / "projects" / "shadow-scripts"))

import psycopg2
from psycopg2.extras import execute_values

def extract_relationship_data(content: str) -> dict | None:
    """Extract relationship JSON from memory content (may be markdown-wrapped)."""
    try:
        # Try direct parse first
        return json.loads(content)
    except json.JSONDecodeError:
        pass
    
    # Extract JSON from markdown
    json_match = re.search(r'\{[\s\S]*\}', content)
    if json_match:
        try:
            return json.loads(json_match.group())
        except json.JSONDecodeError:
            pass
    
    return None


def main():
    # Connect to shadow database
    conn = psycopg2.connect("dbname=shadow")
    cur = conn.cursor()
    
    # Fetch all relationship records from memories table
    cur.execute("""
        SELECT id, content, tags
        FROM memories
        WHERE content ILIKE '%relationship_type%'
        ORDER BY id
    """)
    
    rows = cur.fetchall()
    print(f"Found {len(rows)} potential relationship records")
    
    # Parse relationships
    relationships = []
    entities = set()
    
    for row in rows:
        content = row[1]
        tags = row[2] or []
        
        data = extract_relationship_data(content)
        if not data:
            continue
        
        entity_a = data.get('entity_a', '')
        entity_b = data.get('entity_b', '')
        rel_type = data.get('relationship_type', 'knows')
        confidence = data.get('confidence', 50)
        
        if entity_a and entity_b:
            entities.add(entity_a)
            entities.add(entity_b)
            relationships.append({
                'from_slug': entity_a,
                'to_slug': entity_b,
                'type': rel_type,
                'strength': confidence / 100.0,
            })
    
    print(f"Parsed {len(relationships)} relationships from {len(entities)} entities")
    
    # Clear existing relationships
    cur.execute("TRUNCATE relationships")
    
    # Get slug -> id mapping from people table
    cur.execute("SELECT id, name FROM people")
    slug_to_id = {}
    for row in cur.fetchall():
        slug = row[1].lower().replace(' ', '-').replace('.', '')
        slug_to_id[slug] = row[0]
    
    # Insert relationships
    inserted = 0
    for rel in relationships:
        from_id = slug_to_id.get(rel['from_slug'])
        to_id = slug_to_id.get(rel['to_slug'])
        
        if from_id and to_id:
            cur.execute("""
                INSERT INTO relationships (from_id, to_id, type, strength)
                VALUES (%s, %s, %s, %s)
            """, (from_id, to_id, rel['type'], rel['strength']))
            inserted += 1
    
    conn.commit()
    print(f"Inserted {inserted} relationships")
    
    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
