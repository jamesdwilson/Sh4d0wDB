#!/usr/bin/env python3
"""Export Apple Contacts to a JSON lookup file: phone -> name"""
import subprocess, json, re

# Get all contacts with phone numbers via AppleScript
script = '''
tell application "Contacts"
    set output to ""
    repeat with p in every person
        set pName to name of p
        set pPhones to value of every phone of p
        if (count of pPhones) > 0 then
            repeat with ph in pPhones
                set output to output & pName & "|||" & ph & linefeed
            end repeat
        end if
    end repeat
    return output
end tell
'''
result = subprocess.run(['osascript', '-e', script], capture_output=True, text=True, timeout=30)
lines = result.stdout.strip().split('\n')

def normalize_phone(p):
    digits = re.sub(r'[^\d]', '', p)
    if len(digits) == 10:
        digits = '1' + digits
    if len(digits) == 11 and digits[0] == '1':
        return '+' + digits
    return '+' + digits if digits else None

lookup = {}
for line in lines:
    if '|||' not in line:
        continue
    name, phone = line.split('|||', 1)
    name = name.strip()
    phone = phone.strip()
    norm = normalize_phone(phone)
    if norm and name:
        lookup[norm] = name

with open('contacts-lookup.json', 'w') as f:
    json.dump(lookup, f, indent=2)

print(f"Exported {len(lookup)} phone->name mappings")
