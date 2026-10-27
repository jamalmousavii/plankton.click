import { Component } from 'react';
import Link from 'next/link';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('ErrorBoundary caught:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen page-surface flex items-center justify-center">
          <div className="text-center max-w-lg mx-auto p-6">
            <h1 className="text-xl text-gray-800 mb-4">Something went wrong</h1>
            <pre className="text-xs text-red-600 bg-red-50 border border-red-100 p-3 rounded-lg mb-4 text-left overflow-auto max-h-40">{this.state.error?.message || 'Unknown error'}</pre>
            <button onClick={() => { this.setState({ hasError: false, error: null }); window.location.reload(); }}
              className="text-sky-600 hover:text-sky-700 underline">Try Again</button>
            <br /><Link href="/" className="text-gray-500 hover:text-gray-700 text-sm mt-2 inline-block">← Go Home</Link>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
