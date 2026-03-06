#!/usr/bin/env python3
"""
Contact Import Tool
Imports contacts from contact-graph.json to ShadowDB memory tools.

Usage:
    python3 contact-import.py --preview     # Show what would be imported
    python3 contact-import.py --import      # Perform import
    python3 contact-import.py --test        # Run tests
"""

import json
import subprocess
import sys
from pathlib import Path

CONTACT_GRAPH = Path("/Users/james/.openclaw/workspace/contact-graph.json")
MIN_INTERACTIONS = 2

def load_contact_graph():
    """Load contact graph from JSON."""
    if not CONTACT_GRAPH.exists():
        raise FileNotFoundError(f"Contact graph not found: {CONTACT_GRAPH}")
    
    with open(CONTACT_GRAPH) as f:
        return json.load(f)

def check_contact_exists(name):
    """Check if contact already exists in ShadowDB."""
    try:
        result = subprocess.run(
            ['memory_search', '--query', name, '--maxResults', '5', '--category', 'contacts'],
            capture_output=True,
            text=True,
            timeout=10
        )
        
        if result.returncode != 0:
            return False
        
        # Parse results - if name appears in results, contact exists
        results = json.loads(result.stdout) if result.stdout.strip() else {}
        for hit in results.get('results', []):
            if name.lower() in hit.get('snippet', '').lower():
                return True
        
        return False
    except Exception as e:
        print(f"[WARN] Could not check existence for {name}: {e}")
        return False

def filter_contacts(contacts):
    """Filter contacts by interaction threshold."""
    filtered = []
    
    for contact in contacts:
        name = contact.get('name', '')
        total = contact.get('total_interactions', 0)
        
        # Skip invalid names
        if not name or len(name) < 3:
            continue
        
        # Skip phone numbers as names
        if name.startswith('+') or name.replace('-', '').replace(' ', '').isdigit():
            continue
        
        # Skip contacts below threshold
        if total < MIN_INTERACTIONS:
            continue
        
        filtered.append(contact)
    
    return filtered

def build_contact_content(contact):
    """Build markdown content for contact."""
    name = contact.get('name', 'Unknown')
    total = contact.get('total_interactions', 0)
    org = contact.get('organization')
    interactions = contact.get('interactions', {})
    
    content = f"# {name}\n\n"
    content += "## Contact Info\n"
    
    if org:
        content += f"- Organization: {org}\n"
    
    content += f"- Total interactions: {total}\n\n"
    
    if interactions:
        content += "## Interaction Summary\n"
        
        for channel, data in sorted(interactions.items()):
            count = data.get('count', 0)
            if count > 0:
                content += f"\n### {channel.capitalize()}\n"
                content += f"- Count: {count}\n"
                
                if data.get('last_date'):
                    content += f"- Last: {data['last_date']}\n"
    
    content += "\n## Source\n"
    content += "Imported from contact graph on 2026-03-03\n"
    
    return content

def import_contact(contact, dry_run=False):
    """Import single contact to ShadowDB."""
    name = contact.get('name', 'Unknown')
    
    if dry_run:
        return {'status': 'preview', 'name': name}
    
    # Check if already exists
    if check_contact_exists(name):
        return {'status': 'skipped', 'name': name, 'reason': 'already exists'}
    
    content = build_contact_content(contact)
    metadata = {
        'interactions': contact.get('interactions', {}),
        'total_interactions': contact.get('total_interactions', 0),
        'organization': contact.get('organization'),
        'imported_from': 'contact_graph_2026-03-03'
    }
    
    try:
        result = subprocess.run(
            ['memory_write',
             '--content', content,
             '--category', 'contacts',
             '--title', name,
             '--metadata', json.dumps(metadata),
             '--tags', json.dumps(['contact', 'imported']),
             '--record_type', 'document'],
            capture_output=True,
            text=True,
            timeout=15
        )
        
        if result.returncode == 0:
            return {'status': 'imported', 'name': name}
        else:
            return {'status': 'error', 'name': name, 'error': result.stderr[:200]}
    
    except subprocess.TimeoutExpired:
        return {'status': 'error', 'name': name, 'error': 'timeout'}
    except Exception as e:
        return {'status': 'error', 'name': name, 'error': str(e)}

def preview_import():
    """Preview what would be imported."""
    graph = load_contact_graph()
    contacts = filter_contacts(graph.get('contacts', []))
    
    print(f"=== CONTACT IMPORT PREVIEW ===")
    print(f"Total contacts in graph: {len(graph.get('contacts', []))}")
    print(f"Contacts with >= {MIN_INTERACTIONS} interactions: {len(contacts)}")
    print(f"\nTop 20 by interactions:\n")
    
    # Sort by interactions descending
    sorted_contacts = sorted(contacts, key=lambda c: c.get('total_interactions', 0), reverse=True)
    
    for i, contact in enumerate(sorted_contacts[:20], 1):
        name = contact.get('name', 'Unknown')
        total = contact.get('total_interactions', 0)
        org = contact.get('organization', 'N/A')
        print(f"{i:2}. {name:30} ({total:4} interactions) - {org}")
    
    print(f"\nRun with --import to import all {len(contacts)} contacts")

def run_import():
    """Perform actual import."""
    graph = load_contact_graph()
    contacts = filter_contacts(graph.get('contacts', []))
    
    stats = {
        'total': len(contacts),
        'imported': 0,
        'skipped': 0,
        'errors': 0
    }
    
    print(f"=== IMPORTING {len(contacts)} CONTACTS ===\n")
    
    for i, contact in enumerate(contacts, 1):
        name = contact.get('name', 'Unknown')
        total = contact.get('total_interactions', 0)
        
        result = import_contact(contact, dry_run=False)
        
        status = result['status']
        
        if status == 'imported':
            stats['imported'] += 1
            print(f"[{i}/{len(contacts)}] ✓ {name} ({total} interactions)")
        elif status == 'skipped':
            stats['skipped'] += 1
            print(f"[{i}/{len(contacts)}] ⊘ {name} (already exists)")
        else:
            stats['errors'] += 1
            print(f"[{i}/{len(contacts)}] ✗ {name}: {result.get('error', 'unknown error')}")
    
    print(f"\n=== IMPORT COMPLETE ===")
    print(f"Imported: {stats['imported']}")
    print(f"Skipped:  {stats['skipped']}")
    print(f"Errors:   {stats['errors']}")
    
    return stats['errors'] == 0

def run_tests():
    """Run unit tests."""
    print("=== RUNNING TESTS ===\n")
    
    tests_passed = 0
    tests_failed = 0
    
    # Test 1: Load contact graph
    try:
        graph = load_contact_graph()
        assert 'contacts' in graph
        assert len(graph['contacts']) > 0
        print("✓ Test 1: Load contact graph")
        tests_passed += 1
    except Exception as e:
        print(f"✗ Test 1: Load contact graph - {e}")
        tests_failed += 1
    
    # Test 2: Filter contacts
    try:
        contacts = filter_contacts(graph.get('contacts', []))
        assert len(contacts) > 0
        assert all(c.get('total_interactions', 0) >= MIN_INTERACTIONS for c in contacts)
        print(f"✓ Test 2: Filter contacts (found {len(contacts)})")
        tests_passed += 1
    except Exception as e:
        print(f"✗ Test 2: Filter contacts - {e}")
        tests_failed += 1
    
    # Test 3: Build contact content
    try:
        test_contact = {
            'name': 'Test User',
            'organization': 'Test Org',
            'total_interactions': 10,
            'interactions': {
                'imsg': {'count': 5, 'last_date': '2026-03-01'},
                'email': {'count': 5}
            }
        }
        content = build_contact_content(test_contact)
        assert 'Test User' in content
        assert 'Test Org' in content
        assert '10' in content
        print("✓ Test 3: Build contact content")
        tests_passed += 1
    except Exception as e:
        print(f"✗ Test 3: Build contact content - {e}")
        tests_failed += 1
    
    # Test 4: Check contact exists
    try:
        exists = check_contact_exists('Beth Womack')
        assert isinstance(exists, bool)
        print(f"✓ Test 4: Check contact exists (Beth Womack: {exists})")
        tests_passed += 1
    except Exception as e:
        print(f"✗ Test 4: Check contact exists - {e}")
        tests_failed += 1
    
    # Test 5: Preview import (dry run)
    try:
        result = import_contact(
            {'name': 'Test Import User', 'total_interactions': 5},
            dry_run=True
        )
        assert result['status'] == 'preview'
        print("✓ Test 5: Preview import (dry run)")
        tests_passed += 1
    except Exception as e:
        print(f"✗ Test 5: Preview import - {e}")
        tests_failed += 1
    
    print(f"\n=== TEST RESULTS ===")
    print(f"Passed: {tests_passed}")
    print(f"Failed: {tests_failed}")
    
    return tests_failed == 0

def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return
    
    cmd = sys.argv[1]
    
    if cmd == '--preview':
        preview_import()
    elif cmd == '--import':
        success = run_import()
        sys.exit(0 if success else 1)
    elif cmd == '--test':
        success = run_tests()
        sys.exit(0 if success else 1)
    else:
        print(f"Unknown command: {cmd}")
        sys.exit(1)

if __name__ == '__main__':
    main()
