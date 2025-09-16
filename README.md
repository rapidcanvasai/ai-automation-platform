# Test Automation Platform

An intelligent test automation platform with AI-powered auto-healing capabilities.

## 🚀 Features

- **Natural Language to Code**: Convert plain English test descriptions to executable code
- **AI-Powered Code Generation**: Generate Selenium/Playwright code automatically
- **Auto-Healing**: Automatically fix locator issues using AI
- **Comprehensive Recording**: Capture video, logs, and execution details
- **Smart Reporting**: Generate detailed reports with failure analysis
- **Code Reusability**: Save and reuse generated code to reduce AI calls

## 🏗️ Architecture

### High-Level Architecture
```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   QA Interface  │    │  Core Platform   │    │  Test Execution │
│                 │    │                  │    │                 │
│ • Natural Lang  │───▶│ • NLP Processor  │───▶│ • Test Runner   │
│ • Test Builder  │    │ • Code Generator │    │ • Recorder      │
│ • Report Viewer │    │ • Auto-Healer    │    │ • Executor      │
└─────────────────┘    └──────────────────┘    └─────────────────┘
                                │
                                ▼
                       ┌──────────────────┐
                       │  Storage Layer   │
                       │                  │
                       │ • Test Code      │
                       │ • Test Results   │
                       │ • Healing Data   │
                       │ • AI Models      │
                       └──────────────────┘
```

### Component Breakdown

#### Frontend Layer (QA Interface)
- **Natural Language Input**: Text area for QAs to describe test steps
- **Test Builder**: Visual interface for creating and editing tests
- **Report Dashboard**: View test results, videos, and analytics
- **Test Library**: Browse and manage existing tests

#### Core Platform
- **NLP Processor**: Converts natural language to structured test steps
- **Gherkin Generator**: Creates Gherkin feature files
- **Code Generator**: Produces Selenium/Playwright code
- **Auto-Healer**: AI-powered locator repair system
- **Test Orchestrator**: Manages test execution flow

#### Test Execution Engine
- **Test Runner**: Executes generated test code
- **Video Recorder**: Captures browser sessions
- **Step Logger**: Tracks each test action
- **Failure Handler**: Manages errors and triggers healing

## 🛠️ Technology Stack

### Backend
- **Language**: Node.js with TypeScript
- **Framework**: Express.js
- **Database**: PostgreSQL for structured data, Redis for caching
- **AI/ML**: OpenAI API, TensorFlow.js for custom models
- **Test Automation**: Playwright (primary), Selenium (fallback)

### Frontend
- **Framework**: React with TypeScript
- **UI Library**: Material-UI
- **State Management**: React Query
- **Video**: WebRTC for recording, FFmpeg for processing

### Infrastructure
- **Containerization**: Docker
- **Orchestration**: Docker Compose (dev), Kubernetes (prod)
- **Monitoring**: Prometheus + Grafana
- **Logging**: Winston + ELK Stack

## 🚀 Quick Start

### Prerequisites
- Node.js 18+
- Docker and Docker Compose
- PostgreSQL 15+
- Redis 7+

### Development Setup

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd test-automation-platform
   ```

2. **Install dependencies**
   ```bash
   npm run install:all
   ```

3. **Start the development environment**
   ```bash
   npm run docker:up
   npm run dev
   ```

4. **Access the application**
   - Frontend: http://localhost:3000
   - Backend API: http://localhost:3001
   - Database: localhost:5432

### API Endpoints

- `POST /api/nlp/parse` - Parse natural language to test steps
- `POST /api/nlp/generate-code` - Generate code from parsed steps
- `POST /api/nlp/natural-language-to-code` - Complete workflow
- `GET /api/tests` - Get all tests
- `POST /api/tests` - Create new test
- `POST /api/execution/:id/run` - Execute test

## 📁 Project Structure

```
├── backend/                 # Backend API server
│   ├── src/
│   │   ├── controllers/    # API route handlers
│   │   ├── services/       # Business logic
│   │   │   ├── nlp/        # Natural language processing
│   │   │   ├── codeGenerator/ # Code generation
│   │   │   ├── testExecutor/  # Test execution
│   │   │   └── autoHealer/    # Auto-healing system
│   │   ├── models/         # Data models
│   │   └── middleware/     # Express middleware
│   └── tests/              # Backend tests
├── frontend/               # React frontend application
│   ├── src/
│   │   ├── components/     # Reusable UI components
│   │   ├── pages/          # Page components
│   │   └── services/       # API client services
├── shared/                 # Shared types and utilities
└── infrastructure/         # Docker and deployment configs
```

## 🔧 Development

### Backend Development
```bash
cd backend
npm run dev          # Start development server
npm run build        # Build for production
npm test            # Run tests
```

### Frontend Development
```bash
cd frontend
npm run dev         # Start development server
npm run build       # Build for production
npm test           # Run tests
```

### Database Setup
```bash
# Start PostgreSQL and Redis
docker-compose up postgres redis

# Create database (if needed)
createdb test_automation
```

## 🧪 Testing

### Backend Tests
```bash
cd backend
npm test            # Run all tests
npm run test:watch  # Run tests in watch mode
```

### Frontend Tests
```bash
cd frontend
npm test            # Run all tests
npm run test:ui     # Run tests with UI
```

## 🚀 Deployment

### Production Build
```bash
npm run build
```

### Docker Deployment
```bash
docker-compose -f docker-compose.prod.yml up -d
```

### Environment Variables
Copy `.env.example` to `.env` and configure:
- Database credentials
- API keys
- JWT secrets
- File storage paths

## 🔮 Roadmap

### Phase 1: Foundation ✅
- [x] Project setup and structure
- [x] Basic NLP processing
- [x] Code generation
- [x] Simple test execution

### Phase 2: Core Features 🚧
- [ ] Gherkin integration
- [ ] Enhanced code generation
- [ ] Basic recording
- [ ] Simple reporting

### Phase 3: Intelligence 📋
- [ ] Auto-healing system
- [ ] Video recording
- [ ] Advanced reporting
- [ ] Code storage

### Phase 4: Enhancement 📋
- [ ] Proactive healing
- [ ] Performance optimization
- [ ] Advanced analytics
- [ ] Integration APIs

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Development Guidelines
- Follow TypeScript best practices
- Write comprehensive tests
- Update documentation
- Follow the existing code style

## 📊 Performance Metrics

### Technical Metrics
- **Test Success Rate**: Target >95%
- **Healing Success Rate**: Target >80%
- **Code Generation Time**: <30 seconds per test
- **Healing Response Time**: <10 seconds

### Business Metrics
- **QA Productivity**: 3x improvement in test creation
- **Maintenance Reduction**: 70% reduction in test maintenance
- **Cost Savings**: 60% reduction in AI API costs
- **Test Reliability**: 90% reduction in flaky tests

## 🐛 Troubleshooting

### Common Issues

1. **Database Connection Failed**
   - Ensure PostgreSQL is running
   - Check database credentials in `.env`
   - Verify database exists

2. **Frontend Build Errors**
   - Clear node_modules and reinstall
   - Check TypeScript version compatibility
   - Verify all dependencies are installed

3. **API Connection Issues**
   - Check backend server is running
   - Verify API URL in frontend configuration
   - Check CORS settings

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- OpenAI for AI capabilities
- Playwright team for test automation framework
- Material-UI for the beautiful UI components
- The open-source community for inspiration and tools

## 📞 Support

For support and questions:
- Create an issue in the repository
- Contact the development team
- Check the documentation

---

**Built with ❤️ by the Test Automation Team**
