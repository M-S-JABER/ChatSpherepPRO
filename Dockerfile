# Dockerfile
FROM node:24-alpine
WORKDIR /app

# تثبيت الحزم
COPY package*.json ./
RUN npm install

# نسخ السورس
COPY . .

# المنفذ حسب README
EXPOSE 8080

# افتراض أن سكربت dev هو:
# "dev": "tsx --env-file=.env server/index.ts"
CMD ["npm", "run", "dev"]
