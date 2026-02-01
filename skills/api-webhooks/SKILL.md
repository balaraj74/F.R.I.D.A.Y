# API & Webhooks Integration

Interact with REST APIs, GraphQL endpoints, and webhooks for third-party integrations.

## Commands

### HTTP Requests
```bash
# GET request
curl -s "https://api.example.com/endpoint" | jq

# POST with JSON
curl -s -X POST "https://api.example.com/endpoint" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"key": "value"}'

# PUT/PATCH/DELETE
curl -s -X PUT "https://api.example.com/resource/123" -d '{"updated": true}'
curl -s -X DELETE "https://api.example.com/resource/123"
```

### Webhook Testing
```bash
# Start local webhook receiver (port 9999)
nc -l -p 9999

# Send test webhook
curl -X POST http://localhost:9999/webhook \
  -H "Content-Type: application/json" \
  -d '{"event": "test", "data": {"message": "Hello"}}'
```

### API Response Processing
```bash
# Parse JSON with jq
curl -s "https://api.example.com/data" | jq '.items[] | {id, name}'

# Save response to file
curl -s "https://api.example.com/data" -o response.json

# Check HTTP status code
curl -s -o /dev/null -w "%{http_code}" "https://api.example.com/health"
```

## Common Integrations

### GitHub API
```bash
# List repos
curl -s -H "Authorization: token $GITHUB_TOKEN" \
  "https://api.github.com/user/repos" | jq '.[].name'

# Create issue
curl -s -X POST -H "Authorization: token $GITHUB_TOKEN" \
  "https://api.github.com/repos/OWNER/REPO/issues" \
  -d '{"title": "Bug report", "body": "Description here"}'
```

### Notion API
```bash
curl -s -X POST "https://api.notion.com/v1/pages" \
  -H "Authorization: Bearer $NOTION_API_KEY" \
  -H "Notion-Version: 2022-06-28" \
  -H "Content-Type: application/json" \
  -d '{"parent": {"database_id": "..."}, "properties": {...}}'
```

### Slack Webhooks
```bash
curl -X POST "$SLACK_WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -d '{"text": "Message from FRIDAY 🦾"}'
```

### Discord Webhooks
```bash
curl -X POST "$DISCORD_WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -d '{"content": "Hello from FRIDAY!", "username": "FRIDAY"}'
```

## Tools Required
- `curl` - HTTP client
- `jq` - JSON processor
- `httpie` (optional) - User-friendly HTTP client
- `websocat` (optional) - WebSocket client

## Installation
```bash
sudo apt install -y curl jq
# Optional: pip install httpie
```
