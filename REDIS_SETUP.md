# Redis Setup for Production

## 🚨 **Important: Redis Required for Campaign Features**

The email and WhatsApp campaign features require Redis to function. Without Redis:
- ✅ Server will start normally
- ✅ All other API endpoints work
- ❌ Email campaigns cannot be scheduled/sent
- ❌ WhatsApp campaigns cannot be scheduled/sent

---

## **Option 1: Upstash Redis (Recommended for Production)**

### **1. Create Upstash Account**
- Go to [https://upstash.com/](https://upstash.com/)
- Sign up for free account
- Create a new Redis database

### **2. Get Connection String**
- Copy the `UPSTASH_REDIS_REST_URL` from dashboard
- Or use the connection URL format

### **3. Add to Environment Variables**

```bash
# Option A: Upstash Redis URL
UPSTASH_REDIS_URL=redis://:your-password@your-redis-url.upstash.io:6379

# Option B: Upstash Cloud URL (alternative)
REDIS_CLOUD_URL=redis://:your-password@your-redis-url.upstash.io:6379
```

---

## **Option 2: Local Redis (Development Only)**

### **Install Redis Locally**

**Ubuntu/Debian:**
```bash
sudo apt update
sudo apt install redis-server
sudo systemctl start redis-server
sudo systemctl enable redis-server
```

**macOS:**
```bash
brew install redis
brew services start redis
```

**Windows:**
- Download from [https://redis.io/download](https://redis.io/download)
- Or use Docker: `docker run -d -p 6379:6379 redis`

### **Environment Variables**
```bash
REDIS_HOST=localhost
REDIS_PORT=6379
```

---

## **Option 3: Other Cloud Redis Providers**

### **Redis Cloud**
- [https://redis.com/redis-enterprise-cloud/](https://redis.com/redis-enterprise-cloud/)
- Free tier available

### **AWS ElastiCache**
- [https://aws.amazon.com/elasticache/](https://aws.amazon.com/elasticache/)
- Managed Redis service

### **Google Cloud Memorystore**
- [https://cloud.google.com/memorystore](https://cloud.google.com/memorystore)
- Managed Redis service

---

## **Verifying Redis Connection**

### **Check Server Logs**
When server starts, look for:

✅ **Success:**
```
[EmailWorker] ✅ Email worker started and listening for jobs
[WhatsAppWorker] ✅ WhatsApp worker started and listening for jobs
```

⚠️ **No Redis:**
```
[EmailWorker] ⚠️ Could not start email worker - Redis connection failed
[EmailWorker] Email campaigns will not be processed automatically
[WhatsAppWorker] ⚠️ Could not start WhatsApp worker - Redis connection failed
[WhatsAppWorker] WhatsApp campaigns will not be processed automatically
```

### **Test Campaign Creation**
- If Redis is not configured, campaigns will be created but marked as FAILED
- Error message: "Queue service unavailable. Please configure Redis."

---

## **Production Deployment Checklist**

- [ ] Redis instance created (Upstash/Redis Cloud/etc.)
- [ ] Connection URL added to environment variables
- [ ] Server restarted to pick up new env vars
- [ ] Test email campaign creation
- [ ] Test WhatsApp campaign creation
- [ ] Verify worker logs show success messages
- [ ] Monitor Redis memory usage

---

## **Troubleshooting**

### **Connection Refused (ECONNREFUSED)**
- Check if Redis URL is correct
- Verify firewall/network settings
- Ensure Redis instance is running
- Check if port is accessible

### **DNS Resolution Failed (ENOTFOUND)**
- Verify the hostname in connection URL
- Check if domain is accessible from your server
- Try using IP address instead of hostname

### **Authentication Failed**
- Verify password in connection URL
- Check if Redis requires authentication
- Ensure password doesn't contain special characters that need encoding

---

## **Current Configuration**

The backend checks for Redis in this order:
1. `UPSTASH_REDIS_URL` (for email campaigns)
2. `REDIS_CLOUD_URL` (fallback for email campaigns)
3. `REDIS_HOST` + `REDIS_PORT` (for WhatsApp campaigns, defaults to localhost:6379)

**Recommendation:** Use `UPSTASH_REDIS_URL` for all environments (dev + production)

---

## **Cost Estimation**

### **Upstash Free Tier:**
- ✅ 10,000 requests/day
- ✅ 256 MB storage
- ✅ Perfect for small-medium campaigns

### **Usage Estimate:**
- Email campaign (100 recipients, 3 days) = ~300 Redis operations
- WhatsApp campaign (50 recipients, 3 days) = ~150 Redis operations
- ~1000 campaigns/month fits in free tier

---

## **Support**

If you continue to face Redis connection issues:
1. Check server logs for specific error messages
2. Verify environment variables are correctly set
3. Test Redis connection using `redis-cli` or online tool
4. Contact support with full error logs

