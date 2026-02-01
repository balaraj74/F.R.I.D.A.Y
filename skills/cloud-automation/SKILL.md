# Cloud Automation

Deploy and manage projects on AWS, Azure, and GCP.

## AWS (Amazon Web Services)

### AWS CLI Setup
```bash
# Install
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
unzip awscliv2.zip && sudo ./aws/install

# Configure
aws configure
# Enter: Access Key ID, Secret Access Key, Region, Output format
```

### EC2 Instances
```bash
# List instances
aws ec2 describe-instances --query 'Reservations[].Instances[].[InstanceId,State.Name,Tags[?Key==`Name`].Value|[0]]' --output table

# Start/Stop instance
aws ec2 start-instances --instance-ids i-1234567890abcdef0
aws ec2 stop-instances --instance-ids i-1234567890abcdef0

# Create instance
aws ec2 run-instances --image-id ami-12345678 --instance-type t2.micro --key-name MyKey

# SSH to instance
ssh -i "key.pem" ec2-user@ec2-xx-xx-xx-xx.compute.amazonaws.com
```

### S3 Storage
```bash
# List buckets
aws s3 ls

# Upload/download
aws s3 cp file.txt s3://my-bucket/
aws s3 cp s3://my-bucket/file.txt ./
aws s3 sync ./folder s3://my-bucket/folder

# Create bucket
aws s3 mb s3://my-new-bucket
```

### Lambda Functions
```bash
# List functions
aws lambda list-functions

# Invoke function
aws lambda invoke --function-name MyFunction --payload '{"key": "value"}' output.json

# Deploy (zip)
zip -r function.zip .
aws lambda update-function-code --function-name MyFunction --zip-file fileb://function.zip
```

## Azure

### Azure CLI Setup
```bash
# Install
curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash

# Login
az login

# Set subscription
az account set --subscription "Subscription Name"
```

### Virtual Machines
```bash
# List VMs
az vm list --output table

# Start/Stop VM
az vm start --resource-group MyRG --name MyVM
az vm stop --resource-group MyRG --name MyVM

# Create VM
az vm create --resource-group MyRG --name MyVM --image UbuntuLTS --admin-username azureuser --generate-ssh-keys

# SSH
az ssh vm --resource-group MyRG --name MyVM
```

### Azure Storage
```bash
# List storage accounts
az storage account list --output table

# Upload blob
az storage blob upload --account-name mystorageaccount --container-name mycontainer --name myblob --file ./myfile.txt

# Download blob
az storage blob download --account-name mystorageaccount --container-name mycontainer --name myblob --file ./downloaded.txt
```

### Azure Functions
```bash
# Create function app
az functionapp create --resource-group MyRG --consumption-plan-location eastus --runtime python --name myfuncapp --storage-account mystorageaccount

# Deploy
func azure functionapp publish myfuncapp
```

## Google Cloud Platform (GCP)

### gcloud CLI Setup
```bash
# Install
curl https://sdk.cloud.google.com | bash
exec -l $SHELL

# Initialize
gcloud init

# Login
gcloud auth login
```

### Compute Engine
```bash
# List instances
gcloud compute instances list

# Start/Stop
gcloud compute instances start INSTANCE_NAME --zone=ZONE
gcloud compute instances stop INSTANCE_NAME --zone=ZONE

# Create instance
gcloud compute instances create my-instance --zone=us-central1-a --machine-type=e2-micro

# SSH
gcloud compute ssh INSTANCE_NAME --zone=ZONE
```

### Cloud Storage
```bash
# List buckets
gsutil ls

# Upload/download
gsutil cp file.txt gs://my-bucket/
gsutil cp gs://my-bucket/file.txt ./
gsutil -m rsync -r ./folder gs://my-bucket/folder

# Create bucket
gsutil mb gs://my-new-bucket
```

### Cloud Functions
```bash
# Deploy function
gcloud functions deploy my-function --runtime python39 --trigger-http --allow-unauthenticated

# Invoke
gcloud functions call my-function --data '{"name": "World"}'
```

## Terraform (Infrastructure as Code)

### Basic Terraform
```hcl
# main.tf
provider "aws" {
  region = "us-east-1"
}

resource "aws_instance" "example" {
  ami           = "ami-0c55b159cbfafe1f0"
  instance_type = "t2.micro"
  
  tags = {
    Name = "FRIDAY-Instance"
  }
}
```

### Terraform Commands
```bash
# Initialize
terraform init

# Plan
terraform plan

# Apply
terraform apply

# Destroy
terraform destroy

# Show state
terraform show
```

## Docker & Container Registries

```bash
# Build and push to AWS ECR
aws ecr get-login-password | docker login --username AWS --password-stdin $ECR_URL
docker build -t my-app .
docker tag my-app:latest $ECR_URL/my-app:latest
docker push $ECR_URL/my-app:latest

# Azure Container Registry
az acr login --name myregistry
docker tag my-app myregistry.azurecr.io/my-app:latest
docker push myregistry.azurecr.io/my-app:latest

# Google Container Registry
gcloud auth configure-docker
docker tag my-app gcr.io/my-project/my-app:latest
docker push gcr.io/my-project/my-app:latest
```

## Tools Required
- AWS CLI
- Azure CLI (az)
- Google Cloud SDK (gcloud)
- Terraform
- Docker

## Installation
```bash
# AWS CLI
pip install awscli

# Azure CLI
curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash

# GCP SDK
curl https://sdk.cloud.google.com | bash

# Terraform
sudo apt install -y gnupg software-properties-common
wget -O- https://apt.releases.hashicorp.com/gpg | gpg --dearmor | sudo tee /usr/share/keyrings/hashicorp-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] https://apt.releases.hashicorp.com $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/hashicorp.list
sudo apt update && sudo apt install terraform
```
