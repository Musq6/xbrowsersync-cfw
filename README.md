# xBrowserSync API implementation using Cloudflare worker and KV

This is a simple implementation of the [xBrowserSync API](https://github.com/xbrowsersync/api) using Cloudflare workder.
It uses Cloudflare KV as storage.

## Deployment

- Create a Cloudflare worker project
- Create a KV namespace, and add KV binding in the worker project, name it as `XBSKV`
- Paste the content of [index.js](./index.js) into worker, modify the settings and then save and deploy
- Profit

## Usage

Point your xBrowserSync plugin/app to your worker URL

## 修改
'''javascript
CREATE_NEW_BOOKMARKS_ENABLED = "true"   // 允许新开同步
ALLOWED_ORIGINS = "https://url"         // 允许特定url
MAX_SYNC_SIZE = "10485760"              // 最大文件大小限制10MB
'''
